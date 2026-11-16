/**
 * Watchtower (§12) : suivi des mises à jour d'images faites hors de la plateforme.
 *
 * - chaque cible a un jeton (chiffré) inclus dans l'URL de notification que
 *   Watchtower appelle à la fin de chaque passage ;
 * - le rapport reçu sert aux signalements (nouvelle image disponible) et aux
 *   échecs ; les mises à jour effectives sont constatées sur les conteneurs
 *   (identifiant d'image) : la plateforme ne croit pas le rapport sur parole ;
 * - toute image qui change sans déploiement de la plateforme est historisée et
 *   auditée (Watchtower ou origine inconnue) ;
 * - après un échec, la politique « pause » arrête le conteneur Watchtower.
 */
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import { and, desc, eq, inArray, isNotNull } from 'drizzle-orm'
import { z } from 'zod'
import type { TargetHealthState } from '../../shared/schemas/dashboard'
import { type ImageUpdateDto, type TargetWatchtowerDto, type WatchtowerConfig, type WatchtowerServiceRow, watchtowerConfig } from '../../shared/schemas/watchtower'
import { ACTIVE_STATUSES } from '../../shared/utils/deployment-status'
import type { ContainerState, PortainerConnection } from '../adapters/portainer'
import { portainer } from '../adapters/portainer'
import { db, schema } from '../db/client'
import { WATCHTOWER_SERVICE, watchtowerPolicyOf } from '../lib/compose/analyze'
import { audit } from '../utils/audit'
import { decryptSecret, encryptSecret } from '../utils/crypto'
import { env } from '../utils/env'
import { type TargetRow, getTargetOr404 } from './projects'
import { emitNotification } from './notifications'
import { applyProfile, getProfileOr404, profileRuntime, profileScope } from './watchtower-profiles'
import { connectionFor } from './servers'

type Target = typeof schema.projectTargets.$inferSelect

// ---------------------------------------------------------------------------
// Jeton et URL de notification
// ---------------------------------------------------------------------------

/** Jeton de la cible, créé au premier besoin. */
async function hookToken(target: Target): Promise<string> {
  if (target.watchtowerHookSecretId) {
    const [s] = await db().select({ envelope: schema.secrets.envelope }).from(schema.secrets).where(eq(schema.secrets.id, target.watchtowerHookSecretId))
    if (s) return decryptSecret(s.envelope)
  }
  const token = randomBytes(32).toString('base64url')
  const { envelope, keyId } = encryptSecret(token)
  const [s] = await db().insert(schema.secrets).values({ purpose: 'watchtower_hook', envelope, keyId }).returning({ id: schema.secrets.id })
  await db().update(schema.projectTargets).set({ watchtowerHookSecretId: s!.id }).where(eq(schema.projectTargets.id, target.id))
  target.watchtowerHookSecretId = s!.id
  return token
}

/** URL Shoutrrr « generic » vers la plateforme (le jeton est dans le chemin, jamais journalisé). */
export async function watchtowerHookUrl(target: Target): Promise<string> {
  const base = env().WATCHTOWER_HOOK_BASE_URL ?? env().APP_URL
  return `generic+${base}/api/watchtower/hook/${target.id}/${await hookToken(target)}`
}

/** Variables de stack à fournir quand Watchtower est actif (secrètes : passées à Docker Compose par l'environnement, jamais dans le Compose). */
export async function watchtowerStackEnv(_target: Target): Promise<{ name: string, value: string }[]> {
  // Watchtower des profils du serveur : plus de Watchtower ni de webhook dans la stack du projet.
  return []
}

/** Vérifie le jeton présenté par Watchtower (comparaison à temps constant). */
export async function verifyHookToken(targetId: string, token: string): Promise<Target | null> {
  if (!z.uuid().safeParse(targetId).success || token.length < 20 || token.length > 100) return null
  const [t] = await db().select().from(schema.projectTargets).where(eq(schema.projectTargets.id, targetId))
  if (!t?.watchtowerHookSecretId) return null
  const [s] = await db().select({ envelope: schema.secrets.envelope }).from(schema.secrets).where(eq(schema.secrets.id, t.watchtowerHookSecretId))
  if (!s) return null
  const h = (x: string) => createHash('sha256').update(x).digest()
  return timingSafeEqual(h(decryptSecret(s.envelope)), h(token)) ? t : null
}

// ---------------------------------------------------------------------------
// Rapport de passage
// ---------------------------------------------------------------------------

const entry = z.object({ name: z.string().max(300), image: z.string().max(500), from: z.string().max(100).optional(), to: z.string().max(100).optional(), error: z.string().max(2000).optional() })
export const watchtowerReport = z.object({
  updated: z.array(entry).max(200).default([]),
  failed: z.array(entry).max(200).default([]),
  stale: z.array(entry).max(200).default([]),
})
export type WatchtowerReport = z.infer<typeof watchtowerReport>

/** Analyse tolérante du corps envoyé par Watchtower (vide : passage sans rapport). */
export function parseReport(body: string): WatchtowerReport | null {
  const text = body.trim()
  if (!text) return null
  try {
    const r = watchtowerReport.safeParse(JSON.parse(text))
    return r.success ? r.data : null
  }
  catch {
    return null
  }
}

interface Live {
  t: TargetRow
  conn: PortainerConnection
  containers: ContainerState[]
}

async function live(targetId: string): Promise<Live | null> {
  const t = await getTargetOr404(targetId)
  if (!t.target.stackName) return null
  const [server] = await db().select().from(schema.portainerServers).where(eq(schema.portainerServers.id, t.server.id))
  const conn = await connectionFor(server!)
  const containers = await portainer().stackContainers(conn, t.endpoint.portainerEndpointId, t.target.stackName)
  return { t, conn, containers }
}

const scopeOf = (t: TargetRow) => ({ projectId: t.project.id, environmentId: t.env.id, serverId: t.server.id })

async function notifyWatchtowerError(t: TargetRow, service: string, image: string, error: string, paused: boolean) {
  await emitNotification({
    event: 'watchtower.error', severity: 'error',
    title: `Erreur Watchtower — ${t.project.name} (${t.env.name})`,
    summary: `La mise à jour de ${service} a échoué : ${error}${paused ? '\nWatchtower a été mis en pause pour cette cible.' : ''}`,
    facts: [{ label: 'Service', value: service }, { label: 'Image', value: image }, { label: 'Stack', value: t.target.stackName ?? '—' }],
    path: `/projects/${t.project.id}`,
    ...scopeOf(t),
  })
}

/** Traite un rapport reçu : signalements, échecs (et pause), puis constat des mises à jour. */
export async function handleReport(targetId: string, report: WatchtowerReport | null): Promise<{ available: number, failed: number, updated: number, paused: boolean }> {
  const l = await live(targetId)
  if (!l) return { available: 0, failed: 0, updated: 0, paused: false }
  const { t } = l
  const serviceOf = (name: string) => l.containers.find(c => c.name === name.replace(/^\//, ''))?.service ?? name.replace(/^\//, '')
  let available = 0
  let failed = 0
  let paused = false

  for (const s of report?.stale ?? []) {
    const service = serviceOf(s.name)
    // Une même nouvelle image n'est signalée qu'une fois.
    const [dup] = await db().select({ id: schema.imageUpdates.id }).from(schema.imageUpdates)
      .where(and(eq(schema.imageUpdates.targetId, targetId), eq(schema.imageUpdates.service, service), eq(schema.imageUpdates.kind, 'available'), eq(schema.imageUpdates.toImageId, s.to ?? '')))
    if (dup) continue
    await db().insert(schema.imageUpdates).values({ targetId, service, image: s.image, kind: 'available', fromImageId: s.from, toImageId: s.to ?? '', releaseId: t.target.currentReleaseId, detail: 'Nouvelle image disponible (non appliquée)' })
    await audit({ actorLabel: 'watchtower', action: 'watchtower.available', targetType: 'target', targetId, ...scopeOf(t), outcome: 'success', details: { service, image: s.image, from: s.from, to: s.to } })
    available++
  }

  for (const f of report?.failed ?? []) {
    const service = serviceOf(f.name)
    await db().insert(schema.imageUpdates).values({ targetId, service, image: f.image, kind: 'failed', fromImageId: f.from, toImageId: f.to, releaseId: t.target.currentReleaseId, detail: f.error?.slice(0, 1000) ?? 'Échec de la mise à jour' })
    await audit({ actorLabel: 'watchtower', action: 'watchtower.error', targetType: 'target', targetId, ...scopeOf(t), outcome: 'failure', details: { service, image: f.image, error: f.error } })
    failed++
  }
  if (failed && watchtowerConfig.parse(t.target.watchtower ?? {}).onFailure === 'pause' && !t.target.watchtowerPausedAt) {
    paused = await pauseWatchtower(targetId, 'watchtower', `Échec de mise à jour : ${(report?.failed ?? []).map(f => serviceOf(f.name)).join(', ')}`, l)
  }
  for (const f of report?.failed ?? []) await notifyWatchtowerError(t, serviceOf(f.name), f.image, f.error ?? 'échec', paused)

  const updated = await reconcileTarget(targetId, l)
  return { available, failed, updated, paused }
}

// ---------------------------------------------------------------------------
// Constat des images exécutées
// ---------------------------------------------------------------------------

/** Référence des images après un déploiement de la plateforme (pas un changement « hors plateforme »). */
export async function recordBaseline(targetId: string, containers: ContainerState[]): Promise<void> {
  const now = new Date().toISOString()
  const observed = Object.fromEntries(containers.filter(c => c.service && c.service !== WATCHTOWER_SERVICE).map(c => [c.service!, { image: c.image, imageId: c.imageId, seenAt: now }]))
  await db().update(schema.projectTargets).set({ observedImages: observed }).where(eq(schema.projectTargets.id, targetId))
}

/**
 * Compare les images exécutées à la dernière référence connue. Ignoré pendant une
 * opération de la plateforme (les images y changent légitimement).
 * Renvoie le nombre de changements constatés.
 */
export async function reconcileTarget(targetId: string, given?: Live | null): Promise<number> {
  const [busy] = await db().select({ id: schema.deployments.id }).from(schema.deployments)
    .where(and(eq(schema.deployments.targetId, targetId), inArray(schema.deployments.status, [...ACTIVE_STATUSES])))
  if (busy) return 0
  const l = given ?? await live(targetId)
  if (!l || !l.t.target.currentReleaseId) return 0
  const { t, conn } = l
  const observed = { ...t.target.observedImages }
  const cfg: WatchtowerConfig = watchtowerConfig.parse(t.target.watchtower ?? {})
  let changes = 0
  for (const c of l.containers) {
    if (!c.service || c.service === WATCHTOWER_SERVICE || !c.imageId) continue
    const prev = observed[c.service]
    observed[c.service] = { image: c.image, imageId: c.imageId, seenAt: new Date().toISOString() }
    if (!prev || prev.imageId === c.imageId) continue
    const byWatchtower = cfg.enabled && watchtowerPolicyOf(cfg, c.service, c.labels) === 'update' && c.labels['com.centurylinklabs.watchtower.enable'] === 'true'
    const info = await portainer().imageInfo(conn, t.endpoint.portainerEndpointId, c.imageId).catch(() => null)
    const digest = info?.repoDigests[0] ?? null
    // Conteneur recréé avec la nouvelle image mais arrêté : c'est un échec, pas une mise à jour.
    if (!c.running) {
      const [reported] = await db().select({ id: schema.imageUpdates.id, to: schema.imageUpdates.toImageId }).from(schema.imageUpdates)
        .where(and(eq(schema.imageUpdates.targetId, targetId), eq(schema.imageUpdates.service, c.service), eq(schema.imageUpdates.kind, 'failed')))
        .orderBy(desc(schema.imageUpdates.detectedAt)).limit(1)
      const short = c.imageId.replace(/^sha256:/, '')
      if (!reported?.to || !short.startsWith(reported.to.replace(/^sha256:/, ''))) {
        await db().insert(schema.imageUpdates).values({ targetId, service: c.service, image: c.image, kind: 'failed', fromImageId: prev.imageId, toImageId: c.imageId, digest, releaseId: t.target.currentReleaseId, detail: `Conteneur recréé avec la nouvelle image mais arrêté (${c.status})` })
        await audit({ actorLabel: byWatchtower ? 'watchtower' : 'system', action: 'watchtower.error', targetType: 'target', targetId, ...scopeOf(t), outcome: 'failure', details: { service: c.service, image: c.image, to: c.imageId, status: c.status } })
        await notifyWatchtowerError(t, c.service, c.image, `conteneur recréé mais arrêté (${c.status})`, false)
      }
      changes++
      continue
    }
    await db().insert(schema.imageUpdates).values({
      targetId,
      service: c.service,
      image: c.image,
      kind: byWatchtower ? 'updated' : 'external',
      fromImageId: prev.imageId,
      toImageId: c.imageId,
      digest,
      releaseId: t.target.currentReleaseId,
      detail: byWatchtower ? 'Image mise à jour par Watchtower' : 'Image changée hors de la plateforme (origine inconnue)',
    })
    await audit({
      actorLabel: byWatchtower ? 'watchtower' : 'system',
      action: byWatchtower ? 'watchtower.update' : 'image.external_change',
      targetType: 'target',
      targetId,
      ...scopeOf(t),
      outcome: 'success',
      details: { service: c.service, image: c.image, from: prev.imageId, to: c.imageId, digest },
    })
    changes++
  }
  await db().update(schema.projectTargets).set({ observedImages: observed }).where(eq(schema.projectTargets.id, targetId))
  return changes
}

/**
 * Passage périodique sur toutes les cibles déployées : images exécutées
 * (changements hors plateforme) et santé des services (alerte à la dégradation).
 */
export async function observeAllTargets(): Promise<{ targets: number, changes: number, degraded: number, errors: number }> {
  const targets = await db().select({ id: schema.projectTargets.id }).from(schema.projectTargets)
    .where(and(isNotNull(schema.projectTargets.currentReleaseId), isNotNull(schema.projectTargets.stackName)))
  let changes = 0
  let degraded = 0
  let errors = 0
  for (const r of targets) {
    try {
      const l = await live(r.id)
      if (!l) continue
      changes += await reconcileTarget(r.id, l)
      if ((await observeHealth(l)) !== 'healthy') degraded++
    }
    catch (err) {
      errors++
      console.warn(`[observation] cible ${r.id} : ${(err as Error).message}`)
    }
  }
  const { observeProfiles } = await import('./watchtower-profiles')
  await observeProfiles().catch(err => console.warn(`[observation] profils Watchtower : ${(err as Error).message}`))
  return { targets: targets.length, changes, degraded, errors }
}

/** Santé constatée ; une dégradation (ou une stack arrêtée hors plateforme) est notifiée une fois. */
export async function observeHealth(l: Live): Promise<TargetHealthState['status']> {
  const { t } = l
  const [last] = await db().select({ status: schema.deployments.status }).from(schema.deployments)
    .where(eq(schema.deployments.targetId, t.target.id)).orderBy(desc(schema.deployments.createdAt)).limit(1)
  // Pendant une opération, ou stack volontairement arrêtée : pas de constat.
  if (!last || ACTIVE_STATUSES.includes(last.status) || last.status === 'STOPPED') return 'healthy'
  const paused = !!t.target.watchtowerPausedAt
  const failing = l.containers
    .filter(c => c.service && !(c.service === WATCHTOWER_SERVICE && paused))
    .filter(c => !c.running || c.health === 'unhealthy')
    .map(c => ({ service: c.service!, state: c.running ? 'unhealthy' : c.status }))
  // Services de la release active sans conteneur (supprimé ou stack relancée hors plateforme).
  const [rel] = t.target.currentReleaseId
    ? await db().select({ images: schema.releases.images }).from(schema.releases).where(eq(schema.releases.id, t.target.currentReleaseId))
    : []
  const present = new Set(l.containers.map(c => c.service))
  for (const service of Object.keys(rel?.images ?? {})) {
    if (!present.has(service) && !(service === WATCHTOWER_SERVICE && paused)) failing.push({ service, state: 'absent' })
  }
  // Watchtower appliqué (hors pause) mais supprimé de l'hôte : plus aucune mise à jour, à signaler.
  // (ancien Watchtower par projet seulement : celui d'un profil est surveillé avec le profil)
  const wtApplied = (t.target.watchtowerApplied as { enabled?: boolean, profileId?: string | null } | null)
  if (wtApplied?.enabled && !wtApplied.profileId && !paused && !present.has(WATCHTOWER_SERVICE) && !failing.some(f => f.service === WATCHTOWER_SERVICE)) failing.push({ service: WATCHTOWER_SERVICE, state: 'absent' })
  const status: TargetHealthState['status'] = !l.containers.length ? 'down' : failing.length ? (failing.length >= l.containers.length ? 'down' : 'degraded') : 'healthy'
  const previous = (t.target.healthState as TargetHealthState | null)?.status ?? 'healthy'
  await db().update(schema.projectTargets).set({ healthState: { checkedAt: new Date().toISOString(), status, failing } }).where(eq(schema.projectTargets.id, t.target.id))
  if (status !== 'healthy' && previous === 'healthy') {
    await audit({ actorLabel: 'system', action: 'target.health_degraded', targetType: 'target', targetId: t.target.id, ...scopeOf(t), outcome: 'failure', details: { status, failing } })
    await emitNotification({
      event: 'healthcheck.degraded', severity: t.env.isProduction || status === 'down' ? 'error' : 'warning',
      title: `${t.project.name} (${t.env.name}) ${status === 'down' ? 'à l\'arrêt' : 'dégradé'}`,
      summary: failing.length ? `Services en échec : ${failing.map(f => `${f.service} (${f.state})`).join(', ')}` : 'Aucun conteneur de la stack ne tourne.',
      facts: [{ label: 'Stack', value: t.target.stackName ?? '—' }, { label: 'Serveur', value: t.server.name }],
      path: `/diagnostic/${t.target.id}`,
      ...scopeOf(t),
    })
  }
  else if (status === 'healthy' && previous !== 'healthy') {
    await audit({ actorLabel: 'system', action: 'target.health_recovered', targetType: 'target', targetId: t.target.id, ...scopeOf(t), outcome: 'success', details: {} })
  }
  return status
}

// ---------------------------------------------------------------------------
// Pause / reprise
// ---------------------------------------------------------------------------

function watchtowerContainer(l: Live) {
  return l.containers.find(c => c.service === WATCHTOWER_SERVICE)
}

/** Profil du Watchtower en service pour la cible (null : ancien Watchtower dans la stack, ou aucun). */
const appliedProfileId = (t: TargetRow) => (t.target.watchtowerApplied as { profileId?: string | null } | null)?.profileId ?? null

export async function pauseWatchtower(targetId: string, actor: string, reason: string, given?: Live | null, actorUserId?: string): Promise<boolean> {
  const l = given ?? await live(targetId)
  if (!l) return false
  const profileId = appliedProfileId(l.t)
  if (profileId) {
    // Profil partagé : les conteneurs de ce projet sont exclus de son Watchtower, les autres projets continuent.
    await db().update(schema.projectTargets).set({ watchtowerPausedAt: new Date() }).where(eq(schema.projectTargets.id, targetId))
    await applyProfile(profileId)
  }
  else {
    const c = watchtowerContainer(l)
    if (!c) return false
    await portainer().stopContainer(l.conn, l.t.endpoint.portainerEndpointId, c.id)
    await db().update(schema.projectTargets).set({ watchtowerPausedAt: new Date() }).where(eq(schema.projectTargets.id, targetId))
  }
  await audit({ actorUserId, actorLabel: actor, action: 'watchtower.paused', targetType: 'target', targetId, ...scopeOf(l.t), outcome: 'success', details: { reason } })
  return true
}

export async function resumeWatchtower(targetId: string, actor: string, actorUserId?: string): Promise<boolean> {
  const l = await live(targetId)
  if (!l) return false
  const profileId = appliedProfileId(l.t)
  await db().update(schema.projectTargets).set({ watchtowerPausedAt: null }).where(eq(schema.projectTargets.id, targetId))
  if (profileId) await applyProfile(profileId)
  else {
    const c = watchtowerContainer(l)
    if (!c) return false
    await portainer().startContainer(l.conn, l.t.endpoint.portainerEndpointId, c.id)
  }
  await audit({ actorUserId, actorLabel: actor, action: 'watchtower.resumed', targetType: 'target', targetId, ...scopeOf(l.t), outcome: 'success' })
  return true
}

// ---------------------------------------------------------------------------
// Lecture
// ---------------------------------------------------------------------------


const sameConfig = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b)

/** Vue complète pour l'onglet Watchtower : configuration, services, provenance, historique. */
export async function getTargetWatchtower(t: TargetRow): Promise<TargetWatchtowerDto> {
  const config = watchtowerConfig.parse(t.target.watchtower ?? {})
  const applied = t.target.watchtowerApplied ? watchtowerConfig.parse(t.target.watchtowerApplied) : null
  const [release] = t.target.currentReleaseId ? await db().select().from(schema.releases).where(eq(schema.releases.id, t.target.currentReleaseId)) : []
  const [lastDeploy] = await db().select({
    id: schema.deployments.id, action: schema.deployments.action, status: schema.deployments.status, finishedAt: schema.deployments.finishedAt,
    by: schema.users.email, release: schema.releases.number,
  }).from(schema.deployments)
    .leftJoin(schema.users, eq(schema.users.id, schema.deployments.requestedBy))
    .leftJoin(schema.releases, eq(schema.releases.id, schema.deployments.releaseId))
    .where(and(eq(schema.deployments.targetId, t.target.id), inArray(schema.deployments.action, ['deploy', 'redeploy', 'rollback']), inArray(schema.deployments.status, ['HEALTHY', 'DEGRADED', 'ROLLED_BACK'])))
    .orderBy(desc(schema.deployments.finishedAt)).limit(1)
  const rows = await db().select({ u: schema.imageUpdates, releaseNumber: schema.releases.number }).from(schema.imageUpdates)
    .leftJoin(schema.releases, eq(schema.releases.id, schema.imageUpdates.releaseId))
    .where(eq(schema.imageUpdates.targetId, t.target.id)).orderBy(desc(schema.imageUpdates.detectedAt)).limit(100)
  const updates: ImageUpdateDto[] = rows.map(({ u, releaseNumber }) => ({
    id: u.id, service: u.service, image: u.image, kind: u.kind, fromImageId: u.fromImageId, toImageId: u.toImageId, digest: u.digest,
    releaseNumber, detail: u.detail, detectedAt: u.detectedAt.toISOString(),
  }))
  const since = lastDeploy?.finishedAt?.getTime() ?? 0
  const changed = rows.filter(r => (r.u.kind === 'updated' || r.u.kind === 'external') && r.u.detectedAt.getTime() > since)
  const driftedServices = [...new Set(changed.map(r => r.u.service))]
  const analysis = (release?.analysis ?? {}) as { services?: string[] }
  const builtServices = new Set(Object.entries(release?.images ?? {}).filter(([, img]) => img.startsWith('platform/')).map(([s]) => s))
  const services: WatchtowerServiceRow[] = (analysis.services ?? []).filter(s => s !== WATCHTOWER_SERVICE).map(service => {
    const image = t.target.observedImages[service]?.image ?? release?.images[service] ?? ''
    return { service, image, built: builtServices.has(service), pinned: image.includes('@sha256:'), drifted: driftedServices.includes(service) }
  })
  const last = rows.find(r => r.u.kind === 'updated' || r.u.kind === 'external')
  // État réel du conteneur Watchtower (la configuration appliquée ne dit pas s'il tourne encore).
  let runtime: TargetWatchtowerDto['runtime'] = null
  const profileId = (applied as { profileId?: string | null } | null)?.profileId ?? null
  const profile = profileId ? await getProfileOr404(profileId).catch(() => null) : null
  if (applied?.enabled && profile) runtime = await profileRuntime(profile)
  else if (applied?.enabled) {
    const l = await live(t.target.id).catch(() => null)
    const c = l && watchtowerContainer(l)
    runtime = !l ? { state: 'unknown', detail: 'Hôte injoignable' }
      : !c ? { state: 'missing', detail: 'Conteneur absent de l\'hôte (supprimé hors console)' }
        : c.running ? { state: 'running', detail: c.status }
          : { state: 'stopped', detail: c.status }
  }
  const profiles = await db().select().from(schema.watchtowerProfiles).where(eq(schema.watchtowerProfiles.endpointId, t.endpoint.id))
  return {
    runtime,
    profile: profile ? { id: profile.id, name: profile.name, scope: profileScope(profile) } : null,
    profiles: profiles.map(p => ({ id: p.id, name: p.name, summary: p.timing === 'schedule' ? `Planifié (${p.schedule})` : `Toutes les ${Math.round(p.intervalSec / 60)} min` })),
    serverLink: `/servers/${t.server.id}?tab=watchtower&endpoint=${t.endpoint.id}`,
    config,
    applied,
    pending: !!t.target.currentReleaseId && !sameConfig(config.enabled ? config : null, applied),
    pausedAt: t.target.watchtowerPausedAt?.toISOString() ?? null,
    deployed: !!applied,
    services,
    updates,
    provenance: {
      config: release ? { kind: release.sourceKind === 'github' ? 'github' : 'zip', release: release.number, repository: release.repository, commit: release.commitSha, archiveSha256: release.archiveSha256 } : null,
      lastDeployment: lastDeploy ? { id: lastDeploy.id, action: lastDeploy.action, status: lastDeploy.status, at: lastDeploy.finishedAt!.toISOString(), by: lastDeploy.by, release: lastDeploy.release } : null,
      lastImageUpdate: last ? { at: last.u.detectedAt.toISOString(), service: last.u.service, kind: last.u.kind } : null,
      policy: { enabled: !!applied, mode: applied?.mode ?? null, paused: !!t.target.watchtowerPausedAt, pending: !!t.target.currentReleaseId && !sameConfig(config.enabled ? config : null, applied) },
      driftedServices,
    },
  }
}
