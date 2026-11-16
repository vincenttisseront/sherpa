/**
 * Images à jour ? Pour chaque service d'une cible déployée : empreinte de l'image
 * en cours d'exécution (RepoDigests sur l'hôte) comparée à celle que le registre
 * associe aujourd'hui au même tag. Indépendant de Watchtower : vaut aussi quand
 * Watchtower est désactivé. Lecture seule ; résultats mis en cache.
 */
import { eq, inArray } from 'drizzle-orm'
import type { FreshnessState, TargetFreshness } from '../../shared/schemas/dashboard'
import { portainer } from '../adapters/portainer'
import { db, schema } from '../db/client'
import { RegistryError, parseImageRef, remoteDigest } from '../lib/registry'
import { connectionFor } from './servers'

const TTL_MS = 10 * 60_000
const cache = new Map<string, { at: number, value: Promise<TargetFreshness> }>()

const shortImage = (ref: string) => ref.replace(/^docker\.io\/(library\/)?/, '')

async function check(targetId: string): Promise<TargetFreshness> {
  const [row] = await db().select({ t: schema.projectTargets, ep: schema.serverEndpoints, server: schema.portainerServers })
    .from(schema.projectTargets)
    .innerJoin(schema.serverEndpoints, eq(schema.serverEndpoints.id, schema.projectTargets.endpointId))
    .innerJoin(schema.portainerServers, eq(schema.portainerServers.id, schema.serverEndpoints.serverId))
    .where(eq(schema.projectTargets.id, targetId))
  const checkedAt = new Date().toISOString()
  if (!row?.t.stackName) return { targetId, checkedAt, services: [], error: 'Aucune stack déployée' }
  const conn = await connectionFor(row.server)
  const p = portainer()
  const epId = row.ep.portainerEndpointId
  const containers = await p.stackContainers(conn, epId, row.t.stackName)
  // Un conteneur par service suffit (répliques : même image).
  const byService = new Map(containers.filter(c => c.service).map(c => [c.service!, c]))
  const services = await Promise.all([...byService.entries()].map(async ([service, c]): Promise<TargetFreshness['services'][number]> => {
    const image = shortImage(c.image)
    const base = { service, image }
    if (c.image.startsWith('platform/')) return { ...base, state: 'local', detail: 'Image construite par la plateforme' }
    const ref = parseImageRef(c.image)
    if (!ref) return { ...base, state: 'unknown', detail: 'Référence d\'image illisible' }
    if (ref.digest) return { ...base, state: 'pinned', detail: 'Figée par empreinte : ne change pas' }
    const info = await p.imageInfo(conn, epId, c.imageId).catch(() => null)
    const local = new Set((info?.repoDigests ?? []).map(d => d.slice(d.indexOf('@') + 1)))
    if (!local.size) return { ...base, state: 'local', detail: 'Image sans empreinte de registre (construite ou importée localement)' }
    try {
      const remote = await remoteDigest(ref)
      const state: FreshnessState = local.has(remote) ? 'current' : 'outdated'
      return { ...base, state, detail: state === 'current' ? `À jour (${ref.tag})` : `Nouvelle version publiée pour ${ref.tag}`, remoteDigest: remote }
    }
    catch (err) {
      return { ...base, state: 'unknown', detail: err instanceof RegistryError ? err.message : 'Vérification impossible' }
    }
  }))
  services.sort((a, b) => a.service.localeCompare(b.service))
  return { targetId, checkedAt, services, error: null }
}

export function targetFreshness(targetId: string, refresh = false): Promise<TargetFreshness> {
  const hit = cache.get(targetId)
  if (!refresh && hit && Date.now() - hit.at < TTL_MS) return hit.value
  const value = check(targetId).catch(err => ({ targetId, checkedAt: new Date().toISOString(), services: [], error: `Vérification impossible : ${(err as Error).message.slice(0, 160)}` }))
  cache.set(targetId, { at: Date.now(), value })
  return value
}

/** Plusieurs cibles, trois à la fois. */
export async function freshnessOf(targetIds: string[], refresh = false): Promise<TargetFreshness[]> {
  const deployed = targetIds.length ? (await db().select({ id: schema.projectTargets.id }).from(schema.projectTargets).where(inArray(schema.projectTargets.id, targetIds))).map(r => r.id) : []
  const out: TargetFreshness[] = []
  for (let i = 0; i < deployed.length; i += 3) out.push(...await Promise.all(deployed.slice(i, i + 3).map(id => targetFreshness(id, refresh))))
  return out
}
