/**
 * Profils Watchtower d'un serveur (endpoint) : un conteneur Watchtower par profil, partagé par
 * les projets qui le choisissent, au lieu d'un Watchtower par projet.
 *
 * - le profil porte le rythme (planification ou intervalle), le nettoyage et le délai d'arrêt ;
 * - les services des projets sont rattachés au profil par labels (scope, enable, monitor-only) ;
 * - pause d'un projet : ses conteneurs sont exclus du Watchtower du profil
 *   (WATCHTOWER_DISABLE_CONTAINERS), sans toucher aux autres projets ;
 * - un webhook par profil : le rapport est réparti entre les projets par les labels des conteneurs.
 */
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import { and, eq } from 'drizzle-orm'
import { createError } from 'h3'
import YAML from 'yaml'
import { z } from 'zod'
import { type WatchtowerConfig, type WatchtowerProfileDto, type WatchtowerProfileInput, watchtowerConfig } from '../../shared/schemas/watchtower'
import { portainer } from '../adapters/portainer'
import { db, schema } from '../db/client'
import { WATCHTOWER_REPORT_TEMPLATE, stackNameFor } from '../lib/compose/analyze'
import { decryptSecret, encryptSecret } from '../utils/crypto'
import { env } from '../utils/env'
import { connectionFor } from './servers'
import { effectiveWatchtowerImage } from './update-engine'
import type { TargetRow } from './projects'
import type { WatchtowerReport } from './watchtower'

type Profile = typeof schema.watchtowerProfiles.$inferSelect

export const profileScope = (p: Pick<Profile, 'id'>) => `wt-${p.id.slice(0, 8)}`
export const profileStack = (p: Pick<Profile, 'id'>) => `platform-watchtower-${p.id.slice(0, 8)}`
const HOOK_VAR = 'PLATFORM_WATCHTOWER_HOOK'

async function endpointCtx(endpointId: string) {
  const [r] = await db().select({ ep: schema.serverEndpoints, server: schema.portainerServers })
    .from(schema.serverEndpoints)
    .innerJoin(schema.portainerServers, eq(schema.portainerServers.id, schema.serverEndpoints.serverId))
    .where(eq(schema.serverEndpoints.id, endpointId))
  if (!r) throw createError({ statusCode: 404, statusMessage: 'Endpoint introuvable' })
  return r
}

export async function getProfileOr404(id: string): Promise<Profile> {
  const [p] = z.uuid().safeParse(id).success ? await db().select().from(schema.watchtowerProfiles).where(eq(schema.watchtowerProfiles.id, id)) : []
  if (!p) throw createError({ statusCode: 404, statusMessage: 'Profil Watchtower introuvable' })
  return p
}

const describe = (p: Pick<Profile, 'timing' | 'intervalSec' | 'schedule'>) => p.timing === 'schedule'
  ? `Planifié (${p.schedule})`
  : p.intervalSec % 3600 === 0 ? `Toutes les ${p.intervalSec / 3600} h` : `Toutes les ${Math.round(p.intervalSec / 60)} min`

// ---------------------------------------------------------------------------
// Profils : gestion
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Registres privés du profil (identifiants chiffrés)
// ---------------------------------------------------------------------------

interface RegistryCred { registry: string, username: string, password: string }

async function readRegistries(p: Pick<Profile, 'registriesSecretId'>): Promise<RegistryCred[]> {
  if (!p.registriesSecretId) return []
  const [s] = await db().select({ envelope: schema.secrets.envelope }).from(schema.secrets).where(eq(schema.secrets.id, p.registriesSecretId))
  return s ? JSON.parse(decryptSecret(s.envelope)) as RegistryCred[] : []
}

/** Fusion avec l'existant : mot de passe absent = inchangé (refusé pour un nouveau registre). */
async function storeRegistries(current: Pick<Profile, 'registriesSecretId'> | null, wanted: WatchtowerProfileInput['registries']): Promise<string | null> {
  const before = current ? await readRegistries(current) : []
  const seen = new Set<string>()
  const merged: RegistryCred[] = []
  for (const [i, r] of wanted.entries()) {
    if (seen.has(r.registry)) throw createError({ statusCode: 422, statusMessage: `Registre ${r.registry} déclaré deux fois`, data: { errors: { [`registries.${i}.registry`]: 'Déclaré deux fois' } } })
    seen.add(r.registry)
    const old = before.find(b => b.registry === r.registry && b.username === r.username)
    const password = r.password || old?.password
    if (!password) throw createError({ statusCode: 422, statusMessage: `Mot de passe requis pour ${r.registry}`, data: { errors: { [`registries.${i}.password`]: 'Mot de passe requis' } } })
    merged.push({ registry: r.registry, username: r.username, password })
  }
  if (current?.registriesSecretId) await db().delete(schema.secrets).where(eq(schema.secrets.id, current.registriesSecretId)).catch(() => {})
  if (!merged.length) return null
  const { envelope, keyId } = encryptSecret(JSON.stringify(merged))
  const [s] = await db().insert(schema.secrets).values({ purpose: 'watchtower_registries', envelope, keyId }).returning({ id: schema.secrets.id })
  return s!.id
}

/** config.json Docker : une entrée par registre (Docker Hub sous sa clé historique). */
export function dockerConfigJson(creds: readonly RegistryCred[]): string {
  const key = (r: string) => (['docker.io', 'index.docker.io', 'registry-1.docker.io'].includes(r) ? 'https://index.docker.io/v1/' : r)
  return JSON.stringify({ auths: Object.fromEntries(creds.map(c => [key(c.registry), { auth: Buffer.from(`${c.username}:${c.password}`).toString('base64') }])) })
}
const registriesHash = (creds: readonly RegistryCred[]) => createHash('sha256').update(dockerConfigJson(creds)).digest('hex').slice(0, 16)

export async function createProfile(endpointId: string, input: WatchtowerProfileInput): Promise<Profile> {
  await endpointCtx(endpointId)
  const { registries, ...settings } = input
  try {
    const [p] = await db().insert(schema.watchtowerProfiles).values({ endpointId, ...settings }).returning()
    if (registries.length) {
      const [u] = await db().update(schema.watchtowerProfiles).set({ registriesSecretId: await storeRegistries(null, registries) }).where(eq(schema.watchtowerProfiles.id, p!.id)).returning()
      return u!
    }
    return p!
  }
  catch (err) {
    if ((err as { code?: string }).code === '23505') throw createError({ statusCode: 422, statusMessage: 'Un profil porte déjà ce nom sur ce serveur', data: { errors: { name: 'Nom déjà utilisé' } } })
    throw err
  }
}

export async function updateProfile(id: string, input: WatchtowerProfileInput): Promise<Profile> {
  const current = await getProfileOr404(id)
  const { registries, ...settings } = input
  const registriesSecretId = await storeRegistries(current, registries)
  const [p] = await db().update(schema.watchtowerProfiles).set({ ...settings, registriesSecretId }).where(eq(schema.watchtowerProfiles.id, id)).returning()
  return p!
}

/** Projets (cibles) rattachés à un profil : Watchtower activé et profil résolu. */
async function profileTargets(p: Profile) {
  const rows = await db().select({ t: schema.projectTargets, project: schema.projects, env: schema.environments })
    .from(schema.projectTargets)
    .innerJoin(schema.projects, eq(schema.projects.id, schema.projectTargets.projectId))
    .innerJoin(schema.environments, eq(schema.environments.id, schema.projectTargets.environmentId))
    .where(eq(schema.projectTargets.endpointId, p.endpointId))
  return rows.filter((r) => {
    const cfg = watchtowerConfig.parse(r.t.watchtower ?? {})
    const applied = r.t.watchtowerApplied as (WatchtowerConfig & { profileId?: string | null }) | null
    return (cfg.enabled && cfg.profileId === p.id) || applied?.profileId === p.id
  })
}

export async function deleteProfile(id: string): Promise<void> {
  const p = await getProfileOr404(id)
  const used = await profileTargets(p)
  if (used.length) throw createError({ statusCode: 409, statusMessage: `Profil utilisé par ${used.map(u => `${u.project.name} (${u.env.name})`).join(', ')} : leur choisir un autre profil d'abord` })
  const r = await endpointCtx(p.endpointId)
  const conn = await connectionFor(r.server)
  const stack = await portainer().findStack(conn, profileStack(p), r.ep.portainerEndpointId).catch(() => null)
  if (stack) await portainer().deleteStack(conn, stack.id, r.ep.portainerEndpointId)
  await db().delete(schema.watchtowerProfiles).where(eq(schema.watchtowerProfiles.id, id))
}

/**
 * Profil d'une cible : celui choisi, sinon un profil du serveur au même rythme que l'ancienne
 * configuration de la cible (reprise de l'existant), créé au besoin.
 */
export async function resolveTargetProfile(t: TargetRow): Promise<Profile> {
  const cfg = watchtowerConfig.parse(t.target.watchtower ?? {})
  const profiles = await db().select().from(schema.watchtowerProfiles).where(eq(schema.watchtowerProfiles.endpointId, t.endpoint.id))
  if (cfg.profileId) {
    const chosen = profiles.find(p => p.id === cfg.profileId)
    if (chosen) return chosen
  }
  const wanted = cfg.mode === 'scheduled'
    ? { timing: 'schedule' as const, schedule: cfg.schedule, intervalSec: 86_400 }
    : { timing: 'interval' as const, intervalSec: cfg.intervalSec, schedule: '0 0 4 * * *' }
  const same = profiles.find(p => p.timing === wanted.timing && (wanted.timing === 'schedule' ? p.schedule === wanted.schedule : p.intervalSec === wanted.intervalSec) && p.cleanup === cfg.cleanup && p.stopTimeoutSec === cfg.stopTimeoutSec)
  // Aucun profil à ce rythme : créé (nom rendu unique), pour ne rien changer au comportement du projet.
  let name = describe(wanted)
  for (let i = 2; profiles.some(p => p.name === name); i++) name = `${describe(wanted)} (${i})`
  const profile = same ?? await createProfile(t.endpoint.id, { name, ...wanted, cleanup: cfg.cleanup, stopTimeoutSec: cfg.stopTimeoutSec, registries: [] })
  await db().update(schema.projectTargets).set({ watchtower: { ...cfg, profileId: profile.id } }).where(eq(schema.projectTargets.id, t.target.id))
  t.target.watchtower = { ...cfg, profileId: profile.id }
  return profile
}

// ---------------------------------------------------------------------------
// Jeton et URL de notification du profil
// ---------------------------------------------------------------------------

async function hookToken(p: Profile): Promise<string> {
  if (p.hookSecretId) {
    const [s] = await db().select({ envelope: schema.secrets.envelope }).from(schema.secrets).where(eq(schema.secrets.id, p.hookSecretId))
    if (s) return decryptSecret(s.envelope)
  }
  const token = randomBytes(32).toString('base64url')
  const { envelope, keyId } = encryptSecret(token)
  const [s] = await db().insert(schema.secrets).values({ purpose: 'watchtower_hook', envelope, keyId }).returning({ id: schema.secrets.id })
  await db().update(schema.watchtowerProfiles).set({ hookSecretId: s!.id }).where(eq(schema.watchtowerProfiles.id, p.id))
  p.hookSecretId = s!.id
  return token
}

export async function verifyProfileHook(profileId: string, token: string): Promise<Profile | null> {
  if (!z.uuid().safeParse(profileId).success || token.length < 20 || token.length > 100) return null
  const [p] = await db().select().from(schema.watchtowerProfiles).where(eq(schema.watchtowerProfiles.id, profileId))
  if (!p?.hookSecretId) return null
  const [s] = await db().select({ envelope: schema.secrets.envelope }).from(schema.secrets).where(eq(schema.secrets.id, p.hookSecretId))
  if (!s) return null
  const h = (x: string) => createHash('sha256').update(x).digest()
  return timingSafeEqual(h(decryptSecret(s.envelope)), h(token)) ? p : null
}

// ---------------------------------------------------------------------------
// Conteneur du profil
// ---------------------------------------------------------------------------

/** Compose du Watchtower du profil (un seul service ; URL de notification par l'environnement). */
const DOCKERCFG_VAR = 'PLATFORM_WATCHTOWER_DOCKERCFG'

export function profileCompose(p: Profile, image: string, excluded: readonly string[], withRegistries = false): string {
  const timing = p.timing === 'schedule' ? { WATCHTOWER_SCHEDULE: p.schedule } : { WATCHTOWER_POLL_INTERVAL: String(p.intervalSec) }
  const doc = {
    services: {
      watchtower: {
        image,
        restart: 'unless-stopped',
        volumes: ['/var/run/docker.sock:/var/run/docker.sock'],
        environment: {
          WATCHTOWER_SCOPE: profileScope(p),
          WATCHTOWER_LABEL_ENABLE: 'true',
          WATCHTOWER_CLEANUP: String(p.cleanup),
          WATCHTOWER_TIMEOUT: `${p.stopTimeoutSec}s`,
          ...timing,
          ...(excluded.length ? { WATCHTOWER_DISABLE_CONTAINERS: excluded.join(',') } : {}),
          WATCHTOWER_NOTIFICATIONS: 'shoutrrr',
          WATCHTOWER_NOTIFICATION_URL: `\${${HOOK_VAR}}`,
          WATCHTOWER_NOTIFICATION_REPORT: 'true',
          WATCHTOWER_NOTIFICATION_TEMPLATE: WATCHTOWER_REPORT_TEMPLATE.replaceAll('$', () => '$$'),
          WATCHTOWER_NOTIFICATION_SKIP_TITLE: 'true',
          WATCHTOWER_NO_STARTUP_MESSAGE: 'true',
          ...(withRegistries ? { DOCKER_CONFIG: '/' } : {}),
        },
        // Identifiants des registres : config.json fourni par Compose, contenu passé par l'environnement (jamais écrit).
        ...(withRegistries ? { configs: [{ source: 'dockercfg', target: '/config.json', mode: 0o400 }] } : {}),
        labels: {
          'platform.managed': 'true',
          'platform.role': 'watchtower-profile',
          'platform.watchtower-profile': p.id,
          'com.centurylinklabs.watchtower.scope': profileScope(p),
          'com.centurylinklabs.watchtower.enable': 'false',
        },
      },
    },
  }
  const full = withRegistries ? { ...doc, configs: { dockercfg: { content: `\${${DOCKERCFG_VAR}}` } } } : doc
  return `# Généré par la plateforme — Watchtower du profil « ${p.name} »\n${YAML.stringify(full, { lineWidth: 0 })}`
}

/** Conteneurs exclus : ceux des projets du profil mis en pause, et des stacks détachées de la console. */
async function excludedContainers(p: Profile, conn: Awaited<ReturnType<typeof connectionFor>>, epId: number): Promise<string[]> {
  const paused = (await profileTargets(p)).filter(r => r.t.watchtowerPausedAt)
  if (!paused.length && !p.detachedStacks.length) return []
  const stacks = new Set([...paused.map(r => r.t.stackName ?? stackNameFor(r.project.slug, r.env.key)), ...p.detachedStacks])
  return (await portainer().listContainers(conn, epId))
    .filter(c => stacks.has(c.labels['com.docker.compose.project'] ?? ''))
    .map(c => c.names[0]!.replace(/^\//, ''))
    .sort()
}

/** Déploie (ou met à jour) le Watchtower du profil sur l'hôte. */
export async function applyProfile(id: string): Promise<Profile> {
  const p = await getProfileOr404(id)
  const r = await endpointCtx(p.endpointId)
  const conn = await connectionFor(r.server)
  const epId = r.ep.portainerEndpointId
  const image = await effectiveWatchtowerImage()
  const excluded = await excludedContainers(p, conn, epId)
  const base = env().WATCHTOWER_HOOK_BASE_URL ?? env().APP_URL
  const hook = `generic+${base}/api/watchtower/profile-hook/${p.id}/${await hookToken(p)}`
  const creds = await readRegistries(p)
  const stackEnv = [{ name: HOOK_VAR, value: hook }, ...(creds.length ? [{ name: DOCKERCFG_VAR, value: dockerConfigJson(creds) }] : [])]
  const input = { endpointId: epId, name: profileStack(p), composeContent: profileCompose(p, image, excluded, creds.length > 0), env: stackEnv, pullImage: false }
  const existing = await portainer().findStack(conn, profileStack(p), epId)
  if (existing) await portainer().updateStack(conn, existing.id, input)
  else await portainer().createStack(conn, input)
  const applied = { timing: p.timing, intervalSec: p.intervalSec, schedule: p.schedule, cleanup: p.cleanup, stopTimeoutSec: p.stopTimeoutSec, image, excluded, registries: creds.length ? registriesHash(creds) : null }
  const [u] = await db().update(schema.watchtowerProfiles).set({ applied, appliedAt: new Date() }).where(eq(schema.watchtowerProfiles.id, p.id)).returning()
  return u!
}

/** Déployé si absent, ou si ses réglages ou ses exclusions (projets en pause) ont changé. */
export async function ensureProfileApplied(id: string): Promise<boolean> {
  const p = await getProfileOr404(id)
  const runtime = await profileRuntime(p)
  const r = await endpointCtx(p.endpointId)
  const excluded = await excludedContainers(p, await connectionFor(r.server), r.ep.portainerEndpointId)
  const appliedExcluded = ((p.applied as { excluded?: string[] } | null)?.excluded ?? []).join(',')
  if (!(await pendingOf(p)) && runtime.state === 'running' && excluded.join(',') === appliedExcluded) return false
  await applyProfile(id)
  return true
}

async function pendingOf(p: Profile): Promise<boolean> {
  if (pending(p)) return true
  const creds = await readRegistries(p)
  return ((p.applied as { registries?: string | null }).registries ?? null) !== (creds.length ? registriesHash(creds) : null)
}

function pending(p: Profile): boolean {
  const a = p.applied as Record<string, unknown> | null
  if (!a) return true
  return a.timing !== p.timing || a.intervalSec !== p.intervalSec || a.schedule !== p.schedule || a.cleanup !== p.cleanup || a.stopTimeoutSec !== p.stopTimeoutSec
}

export async function profileRuntime(p: Profile): Promise<WatchtowerProfileDto['runtime']> {
  try {
    const r = await endpointCtx(p.endpointId)
    const c = (await portainer().listContainers(await connectionFor(r.server), r.ep.portainerEndpointId))
      .find(x => x.labels['platform.watchtower-profile'] === p.id)
    if (!c) return { state: 'missing', detail: p.applied ? 'Conteneur absent de l\'hôte (supprimé hors console)' : 'Jamais appliqué' }
    return { state: c.state === 'running' ? 'running' : 'stopped', detail: c.status }
  }
  catch (err) {
    return { state: 'unknown', detail: (err as Error).message.slice(0, 200) }
  }
}

export async function listProfiles(endpointId: string): Promise<WatchtowerProfileDto[]> {
  const profiles = await db().select().from(schema.watchtowerProfiles).where(eq(schema.watchtowerProfiles.endpointId, endpointId)).orderBy(schema.watchtowerProfiles.createdAt)
  return Promise.all(profiles.map(p => profileDto(p)))
}

export async function profileDto(p: Profile): Promise<WatchtowerProfileDto> {
  const targets = await profileTargets(p)
  const a = p.applied as { image?: string, excluded?: string[] } | null
  return {
    id: p.id,
    endpointId: p.endpointId,
    name: p.name,
    timing: p.timing,
    intervalSec: p.intervalSec,
    schedule: p.schedule,
    cleanup: p.cleanup,
    stopTimeoutSec: p.stopTimeoutSec,
    scope: profileScope(p),
    registries: (await readRegistries(p)).map(r => ({ registry: r.registry, username: r.username, hasPassword: !!r.password })),
    appliedAt: p.appliedAt?.toISOString() ?? null,
    pending: await pendingOf(p),
    image: a?.image ?? null,
    runtime: await profileRuntime(p),
    projects: targets.map(r => ({ targetId: r.t.id, project: r.project.name, environment: r.env.name, paused: !!r.t.watchtowerPausedAt })),
    excluded: a?.excluded ?? [],
  }
}

// ---------------------------------------------------------------------------
// Rapport du profil : réparti entre les projets
// ---------------------------------------------------------------------------

/** Entrées du rapport rattachées aux cibles par les labels des conteneurs (projet, environnement). */
export async function splitProfileReport(profileId: string, report: WatchtowerReport | null): Promise<Map<string, WatchtowerReport>> {
  const p = await getProfileOr404(profileId)
  const r = await endpointCtx(p.endpointId)
  const containers = await portainer().listContainers(await connectionFor(r.server), r.ep.portainerEndpointId)
  const targets = await db().select({ id: schema.projectTargets.id, slug: schema.projects.slug, env: schema.environments.key })
    .from(schema.projectTargets)
    .innerJoin(schema.projects, eq(schema.projects.id, schema.projectTargets.projectId))
    .innerJoin(schema.environments, eq(schema.environments.id, schema.projectTargets.environmentId))
    .where(and(eq(schema.projectTargets.endpointId, p.endpointId)))
  const targetOf = (name: string) => {
    const c = containers.find(x => x.names.some(n => n.replace(/^\//, '') === name.replace(/^\//, '')))
    return c && targets.find(t => t.slug === c.labels['platform.project'] && t.env === c.labels['platform.environment'])?.id
  }
  const out = new Map<string, WatchtowerReport>()
  // Passage sans rapport : chaque projet du profil fait son constat.
  if (!report) {
    for (const t of await profileTargets(p)) out.set(t.t.id, { updated: [], failed: [], stale: [] })
    return out
  }
  for (const kind of ['updated', 'failed', 'stale'] as const) {
    for (const e of report[kind]) {
      const id = targetOf(e.name)
      if (!id) continue
      if (!out.has(id)) out.set(id, { updated: [], failed: [], stale: [] })
      out.get(id)![kind].push(e)
    }
  }
  return out
}

/** Rapport d'un profil : chaque projet traite sa part (signalements, échecs et pause, constat). */
export async function handleProfileReport(profileId: string, report: WatchtowerReport | null): Promise<Record<string, unknown>> {
  const { handleReport } = await import('./watchtower')
  const parts = await splitProfileReport(profileId, report)
  const out: Record<string, unknown> = {}
  for (const [targetId, part] of parts) out[targetId] = await handleReport(targetId, part)
  return out
}

/**
 * Surveillance des Watchtower de profil : un conteneur appliqué mais absent ou arrêté est
 * notifié une fois (au changement d'état), et réappliqué s'il a disparu.
 */
export async function observeProfiles(): Promise<{ profiles: number, problems: number }> {
  const { emitNotification } = await import('./notifications')
  const profiles = (await db().select().from(schema.watchtowerProfiles)).filter(p => p.applied)
  let problems = 0
  for (const p of profiles) {
    const runtime = await profileRuntime(p)
    if (runtime.state === 'unknown') continue
    const previous = (p.applied as { lastState?: string }).lastState ?? 'running'
    if (runtime.state !== 'running') problems++
    if (runtime.state !== previous) {
      await db().update(schema.watchtowerProfiles).set({ applied: { ...(p.applied as object), lastState: runtime.state } }).where(eq(schema.watchtowerProfiles.id, p.id))
      if (runtime.state !== 'running') {
        const r = await endpointCtx(p.endpointId)
        await emitNotification({
          event: 'healthcheck.degraded',
          severity: 'warning',
          title: `Watchtower du profil « ${p.name} » ${runtime.state === 'missing' ? 'absent' : 'arrêté'} sur ${r.server.name}`,
          summary: `${runtime.detail ?? ''} : les projets de ce profil ne sont plus surveillés. Réappliquer le profil depuis la fiche du serveur.`,
          facts: [{ label: 'Profil', value: p.name }, { label: 'Serveur', value: r.server.name }],
          path: `/servers/${r.server.id}?tab=watchtower&endpoint=${r.ep.id}`,
          serverId: r.server.id,
        })
      }
    }
  }
  return { profiles: profiles.length, problems }
}

/** Projet détaché de la console : ses conteneurs (qui gardent les labels du profil) sont exclus du profil. */
export async function excludeDetachedStack(profileId: string, stack: string): Promise<void> {
  const p = await getProfileOr404(profileId)
  if (!p.detachedStacks.includes(stack)) {
    await db().update(schema.watchtowerProfiles).set({ detachedStacks: [...p.detachedStacks, stack] }).where(eq(schema.watchtowerProfiles.id, p.id))
  }
}
