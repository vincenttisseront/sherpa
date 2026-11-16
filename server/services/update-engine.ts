/**
 * Moteur de mise à jour des images : image du sidecar platform-watchtower injecté
 * dans les stacks. Choisie par l'administration parmi les dépôts maintenus du
 * catalogue, figée par empreinte (aucun changement silencieux côté registre).
 *
 * Bascule : une cible dont le Watchtower déployé utilise une autre image est « à
 * appliquer » ; l'application la redéploie. Nettoyage : les anciens conteneurs et
 * images Watchtower (projet archivé, versions précédentes) trouvés sur les hôtes
 * sont listés puis supprimés sur demande, après une nouvelle lecture des hôtes.
 */
import { createHash } from 'node:crypto'
import { eq, isNotNull, sql } from 'drizzle-orm'
import { createError } from 'h3'
import { type LegacyWatchtowerItem, UPDATE_ENGINE_CATALOG, type UpdateEngineDto, type UpdateEngineInput, WATCHTOWER_REPOSITORIES } from '../../shared/schemas/update-engine'
import { portainer } from '../adapters/portainer'
import { db, schema } from '../db/client'
import { RegistryError, latestStableTag, listTags, parseImageRef, remoteDigest } from '../lib/registry'
import { audit } from '../utils/audit'
import { type AuthUser, canOn } from '../utils/auth'
import { env } from '../utils/env'
import { createLifecycleAction } from './deploy-requests'
import { liveEndpoints } from './live'
import { getTargetOr404, targetScope } from './projects'
import { connectionFor } from './servers'

const SETTING_KEY = 'update-engine'
export const DEFAULT_WATCHTOWER_IMAGE = 'nickfedor/watchtower:1.23.0'

interface EngineSetting { repository: string, tag: string, digest: string, pinnedAt: string, pinnedBy: string }

/** Forme comparable d'une référence d'image (registre docker.io et library/ implicites). */
export function normalizeImage(image: string): string {
  return image.trim().replace(/^(?:docker\.io|index\.docker\.io|registry-1\.docker\.io)\//, '').replace(/^library\//, '')
}

/** Dépôt d'une référence (sans tag ni empreinte). */
export function repositoryOf(image: string): string {
  const noDigest = normalizeImage(image).split('@')[0]!
  const slash = noDigest.lastIndexOf('/')
  const colon = noDigest.lastIndexOf(':')
  return colon > slash ? noDigest.slice(0, colon) : noDigest
}

const catalogOf = (repository: string) => UPDATE_ENGINE_CATALOG.find(c => c.repository === repository)
export const isRetiredImage = (image: string) => catalogOf(repositoryOf(image))?.status === 'archived'

async function readSetting(): Promise<EngineSetting | null> {
  const [row] = await db().select().from(schema.appSettings).where(eq(schema.appSettings.key, SETTING_KEY))
  return (row?.value as EngineSetting | undefined) ?? null
}

/** Image injectée dans les stacks : réglage figé, sinon WATCHTOWER_IMAGE (une image archivée est ignorée). */
export async function effectiveWatchtowerImage(): Promise<string> {
  const s = await readSetting()
  if (s) return `${s.repository}:${s.tag}@${s.digest}`
  const fromEnv = env().WATCHTOWER_IMAGE
  return isRetiredImage(fromEnv) ? DEFAULT_WATCHTOWER_IMAGE : fromEnv
}

/** Le Watchtower déployé sur la cible n'utilise pas l'image choisie. */
export function engineOutdated(applied: string | null, effective: string): boolean {
  return !applied || normalizeImage(applied) !== normalizeImage(effective)
}

async function outdatedTargets(effective: string) {
  const pt = schema.projectTargets
  const rows = await db().select({ id: pt.id, projectId: pt.projectId, project: schema.projects.name, environment: schema.environments.name, applied: pt.watchtowerImageApplied, cfg: pt.watchtowerApplied })
    .from(pt)
    .innerJoin(schema.projects, eq(schema.projects.id, pt.projectId))
    .innerJoin(schema.environments, eq(schema.environments.id, pt.environmentId))
    .where(sql`${isNotNull(pt.watchtowerApplied)} and ${pt.currentReleaseId} is not null and ${schema.projects.archivedAt} is null`)
  // Cibles sur un profil : c'est le profil qui porte l'image (réappliqué, sans redéployer le projet).
  return rows.filter(r => !(r.cfg as { profileId?: string | null } | null)?.profileId && engineOutdated(r.applied, effective))
    .map(r => ({ targetId: r.id, projectId: r.projectId, project: r.project, environment: r.environment, appliedImage: r.applied }))
}

/** Profils Watchtower dont le conteneur n'utilise pas l'image choisie. */
async function outdatedProfiles(effective: string) {
  const rows = await db().select({ p: schema.watchtowerProfiles, endpoint: schema.serverEndpoints.name, serverId: schema.portainerServers.id, server: schema.portainerServers.name })
    .from(schema.watchtowerProfiles)
    .innerJoin(schema.serverEndpoints, eq(schema.serverEndpoints.id, schema.watchtowerProfiles.endpointId))
    .innerJoin(schema.portainerServers, eq(schema.portainerServers.id, schema.serverEndpoints.serverId))
  return rows.filter(r => r.p.applied && engineOutdated((r.p.applied as { image?: string }).image ?? null, effective))
    .map(r => ({ profileId: r.p.id, name: r.p.name, server: r.server, serverId: r.serverId, endpoint: r.endpoint, appliedImage: (r.p.applied as { image?: string }).image ?? null }))
}

// Dernière version publiée : liste des tags lue au plus toutes les 30 min (registre lent, quotas anonymes).
const LATEST_TTL_MS = 30 * 60_000
const latestCache = new Map<string, { at: number, value: { latest: string | null, latestError: string | null } }>()

async function latestVersion(repository: string, tag: string): Promise<{ latest: string | null, latestError: string | null }> {
  const hit = latestCache.get(repository)
  if (hit && Date.now() - hit.at < LATEST_TTL_MS) return hit.value
  let value: { latest: string | null, latestError: string | null }
  try {
    const ref = parseImageRef(`${repository}:${tag}`)
    if (!ref) throw new RegistryError('Référence d\'image illisible')
    value = { latest: latestStableTag(await listTags(ref)), latestError: null }
    latestCache.set(repository, { at: Date.now(), value })
  }
  catch (err) {
    // Échec non mis en cache : nouvel essai au prochain affichage.
    value = { latest: hit?.value.latest ?? null, latestError: (err as Error).message.slice(0, 200) }
  }
  return value
}

export async function getUpdateEngine(): Promise<UpdateEngineDto> {
  const s = await readSetting()
  const image = await effectiveWatchtowerImage()
  const repository = s?.repository ?? repositoryOf(image)
  const tag = s?.tag ?? (normalizeImage(image).split('@')[0]!.slice(repository.length + 1) || 'latest')
  const { latest, latestError } = await latestVersion(repository, tag)
  const envImage = env().WATCHTOWER_IMAGE
  return {
    image,
    repository,
    tag,
    digest: s?.digest ?? null,
    source: s ? 'setting' : 'env',
    catalog: catalogOf(repository) ?? { repository, maintainer: 'inconnu', source: '', status: 'maintained', note: 'Image hors catalogue (WATCHTOWER_IMAGE).' },
    pinnedAt: s?.pinnedAt ?? null,
    pinnedBy: s?.pinnedBy ?? null,
    latest,
    latestError,
    outdated: await outdatedTargets(image),
    outdatedProfiles: (await outdatedProfiles(image)).map(({ serverId: _s, ...o }) => o),
    envRetired: isRetiredImage(envImage) ? envImage : null,
  }
}

/** Choix d'une version : elle doit exister dans le registre ; son empreinte est figée. */
export async function setUpdateEngine(input: UpdateEngineInput, user: AuthUser): Promise<UpdateEngineDto> {
  const ref = parseImageRef(`${input.repository}:${input.tag}`)
  if (!ref) throw createError({ statusCode: 422, statusMessage: 'Référence d\'image illisible' })
  let digest: string
  try {
    digest = await remoteDigest(ref)
  }
  catch (err) {
    throw createError({ statusCode: 422, statusMessage: `Version introuvable ou registre injoignable : ${(err as Error).message}` })
  }
  const before = await effectiveWatchtowerImage()
  const value: EngineSetting = { repository: input.repository, tag: input.tag, digest, pinnedAt: new Date().toISOString(), pinnedBy: user.email }
  await db().insert(schema.appSettings).values({ key: SETTING_KEY, value, updatedBy: user.id })
    .onConflictDoUpdate({ target: schema.appSettings.key, set: { value, updatedBy: user.id } })
  await audit({ actorUserId: user.id, actorLabel: user.email, action: 'update_engine.set', targetType: 'app_setting', targetId: SETTING_KEY, outcome: 'success', details: { from: before, to: `${input.repository}:${input.tag}@${digest}` } })
  return getUpdateEngine()
}

/** Redéploie les cibles dont le Watchtower n'utilise pas l'image choisie (droits vérifiés par cible). */
export async function applyUpdateEngine(user: AuthUser): Promise<{ started: { targetId: string, deploymentId: string }[], skipped: { targetId: string, reason: string }[], profiles: { profileId: string, error: string | null }[] }> {
  const effective = await effectiveWatchtowerImage()
  const started: { targetId: string, deploymentId: string }[] = []
  const skipped: { targetId: string, reason: string }[] = []
  // Profils : leur conteneur est recréé avec la nouvelle image (les projets ne sont pas redéployés).
  const profiles: { profileId: string, error: string | null }[] = []
  const { applyProfile } = await import('./watchtower-profiles')
  for (const o of await outdatedProfiles(effective)) {
    if (!canOn(user, 'server:manage', { serverId: o.serverId })) {
      profiles.push({ profileId: o.profileId, error: 'hors de vos droits' })
      continue
    }
    try {
      await applyProfile(o.profileId)
      profiles.push({ profileId: o.profileId, error: null })
      await audit({ actorUserId: user.id, actorLabel: user.email, action: 'watchtower.profile_applied', targetType: 'server_endpoint', targetId: o.profileId, serverId: o.serverId, outcome: 'success', details: { reason: 'update_engine', image: effective } })
    }
    catch (err) {
      profiles.push({ profileId: o.profileId, error: (err as Error).message.slice(0, 200) })
    }
  }
  for (const o of await outdatedTargets(effective)) {
    const t = await getTargetOr404(o.targetId)
    if (!canOn(user, 'deployment:execute', targetScope(t))) {
      skipped.push({ targetId: o.targetId, reason: 'hors de vos droits' })
      continue
    }
    try {
      // Une bascule par cible et par image (sans « : » : identifiant de job de la file).
      const deploymentId = await createLifecycleAction(t, 'redeploy', user.id, `update-engine-${o.targetId}-${createHash('sha256').update(effective).digest('hex').slice(0, 16)}`)
      started.push({ targetId: o.targetId, deploymentId })
      await audit({ actorUserId: user.id, actorLabel: user.email, action: 'target.redeploy', targetType: 'deployment', targetId: deploymentId, ...targetScope(t), outcome: 'success', details: { reason: 'update_engine', image: effective } })
    }
    catch (err) {
      skipped.push({ targetId: o.targetId, reason: (err as Error).message.slice(0, 200) })
    }
  }
  return { started, skipped, profiles }
}

/** Anciens Watchtower sur les hôtes : conteneurs et images d'une autre image que celle choisie. */
export async function scanLegacyWatchtower(user: AuthUser): Promise<LegacyWatchtowerItem[]> {
  const effective = normalizeImage(await effectiveWatchtowerImage())
  const effectiveRepoTag = effective.split('@')[0]!
  const effectiveDigest = effective.split('@')[1] ?? null
  // Une référence désigne l'image en service si elle porte son tag ou son empreinte
  // (avec le stockage containerd, une image tirée par empreinte est nommée dépôt@sha256:…).
  const isCurrent = (ref: string) => {
    const n = normalizeImage(ref)
    return n === effective || n === effectiveRepoTag || (!!effectiveDigest && n.endsWith(`@${effectiveDigest}`) && repositoryOf(n) === repositoryOf(effective))
  }
  const items: LegacyWatchtowerItem[] = []
  for (const row of await liveEndpoints(user)) {
    if (!canOn(user, 'server:read', { serverId: row.server.id })) continue
    const conn = await connectionFor(row.server)
    const epId = row.ep.portainerEndpointId
    const [containers, images] = await Promise.all([portainer().listContainers(conn, epId), portainer().listImages(conn, epId)]).catch(() => [[], []] as const)
    const base = { endpointId: row.ep.id, endpoint: row.ep.name, server: row.server.name }
    // Images utilisées : par identifiant (fiable), quel que soit le nom sous lequel elles sont référencées.
    const usedIds = new Set(containers.map(c => c.imageId).filter((x): x is string => !!x))
    const currentIds = new Set(images.filter(i => i.tags.some(isCurrent)).map(i => i.id))
    for (const c of containers) {
      if (!WATCHTOWER_REPOSITORIES.includes(repositoryOf(c.image))) continue
      if (isCurrent(c.image) || (c.imageId && currentIds.has(c.imageId))) continue
      const stack = c.labels['platform.managed'] === 'true' ? c.labels['com.docker.compose.project'] ?? null : null
      items.push({
        ...base, kind: 'container', id: c.id, name: c.names[0] ?? c.id.slice(0, 12), image: c.image, platformStack: stack,
        removable: !stack,
        reason: c.labels['platform.role'] === 'watchtower-profile' ? 'Watchtower d\'un profil : remplacé en appliquant le moteur (ou le profil)' : stack ? `Stack ${stack} de la plateforme : remplacé en redéployant la cible` : isRetiredImage(c.image) ? 'Projet archivé, hors plateforme' : 'Ancienne version, hors plateforme',
      })
    }
    for (const img of images) {
      const tags = img.tags.filter(t => WATCHTOWER_REPOSITORIES.includes(repositoryOf(t)))
      if (!tags.length || currentIds.has(img.id)) continue
      const used = usedIds.has(img.id)
      items.push({
        ...base, kind: 'image', id: img.id, name: tags.join(', '), image: tags[0]!, platformStack: null,
        removable: !used,
        reason: used ? 'Encore utilisée par un conteneur : supprimer ou redéployer d\'abord' : isRetiredImage(tags[0]!) ? 'Image du projet archivé, inutilisée' : 'Ancienne version, inutilisée',
      })
    }
  }
  return items
}

/** Suppression des éléments demandés, uniquement s'ils sont toujours supprimables à la relecture des hôtes. */
export async function cleanupLegacyWatchtower(user: AuthUser, ids: string[]): Promise<{ removed: string[], refused: { id: string, reason: string }[] }> {
  const current = await scanLegacyWatchtower(user)
  const removed: string[] = []
  const refused: { id: string, reason: string }[] = []
  for (const id of ids) {
    const item = current.find(i => i.id === id)
    if (!item || !item.removable) {
      refused.push({ id, reason: item ? item.reason : 'introuvable à la relecture des hôtes' })
      continue
    }
    const [row] = await liveEndpoints(user, item.endpointId)
    if (!row || !canOn(user, 'server:manage', { serverId: row.server.id })) {
      refused.push({ id, reason: 'hors de vos droits' })
      continue
    }
    const conn = await connectionFor(row.server)
    try {
      if (item.kind === 'container') await portainer().removeContainer(conn, row.ep.portainerEndpointId, item.id)
      else await portainer().removeImage(conn, row.ep.portainerEndpointId, item.id)
      removed.push(id)
      await audit({ actorUserId: user.id, actorLabel: user.email, action: `update_engine.cleanup_${item.kind}`, targetType: 'server_endpoint', targetId: item.endpointId, serverId: row.server.id, outcome: 'success', details: { name: item.name, image: item.image } })
    }
    catch (err) {
      refused.push({ id, reason: (err as Error).message.slice(0, 200) })
    }
  }
  return { removed, refused }
}
