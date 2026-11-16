/**
 * Plage d'adresses des réseaux des projets d'un endpoint et attribution des sous-réseaux :
 * chaque réseau d'une cible (réseau implicite « default » compris) reçoit un sous-réseau de la
 * taille choisie, stable d'un déploiement à l'autre, hors des plages réservées, des autres
 * projets et des réseaux Docker déjà présents sur l'hôte.
 */
import { and, eq, inArray, isNotNull, isNull, ne } from 'drizzle-orm'
import { createError } from 'h3'
import YAML from 'yaml'
import type { NetworkPool, NetworkPoolDto } from '../../shared/schemas/network-pool'
import { portainer } from '../adapters/portainer'
import { db, schema } from '../db/client'
import { type Cidr, capacity, firstFree, overlaps, parseCidr, within } from '../lib/subnets'
import { stackOfTarget } from './diagnostic'
import type { TargetRow } from './projects'
import { connectionFor } from './servers'

async function endpointRow(endpointId: string) {
  const [r] = await db().select({ ep: schema.serverEndpoints, server: schema.portainerServers })
    .from(schema.serverEndpoints)
    .innerJoin(schema.portainerServers, eq(schema.portainerServers.id, schema.serverEndpoints.serverId))
    .where(eq(schema.serverEndpoints.id, endpointId))
  if (!r) throw createError({ statusCode: 404, statusMessage: 'Endpoint introuvable' })
  return r
}

/** Sous-réseaux des réseaux Docker de l'hôte (null si l'hôte est injoignable). */
async function hostSubnets(row: Awaited<ReturnType<typeof endpointRow>>): Promise<{ network: string, subnet: string }[] | null> {
  try {
    const nets = await portainer().listNetworksDetailed(await connectionFor(row.server), row.ep.portainerEndpointId)
    return nets.flatMap(n => (n.subnets ?? []).map(subnet => ({ network: n.name, subnet })))
  }
  catch {
    return null
  }
}

export async function getNetworkPool(endpointId: string): Promise<NetworkPoolDto> {
  const row = await endpointRow(endpointId)
  const pool = row.ep.networkPool ?? null
  const allocations = await db().select({ a: schema.networkAllocations, project: schema.projects.name, environment: schema.environments.name })
    .from(schema.networkAllocations)
    .innerJoin(schema.projectTargets, eq(schema.projectTargets.id, schema.networkAllocations.targetId))
    .innerJoin(schema.projects, eq(schema.projects.id, schema.projectTargets.projectId))
    .innerJoin(schema.environments, eq(schema.environments.id, schema.projectTargets.environmentId))
    .where(eq(schema.networkAllocations.endpointId, endpointId))
  const base = pool ? parseCidr(pool.base) : null
  const own = new Set(allocations.map(a => a.a.subnet))
  return {
    pool,
    capacity: base && pool ? capacity(base, pool.prefix) : null,
    allocations: allocations.map(a => ({ project: a.project, environment: a.environment, network: a.a.network, subnet: a.a.subnet, createdAt: a.a.createdAt.toISOString() }))
      .sort((x, y) => x.subnet.localeCompare(y.subnet, undefined, { numeric: true })),
    hostSubnets: ((await hostSubnets(row)) ?? []).filter(h => !own.has(h.subnet)),
  }
}

/** Enregistre la plage ; les attributions qui n'y entrent plus sont retirées (réattribuées au prochain déploiement). */
export async function setNetworkPool(endpointId: string, pool: NetworkPool | null): Promise<{ released: number }> {
  await endpointRow(endpointId)
  if (pool) {
    const base = parseCidr(pool.base)
    if (!base) throw createError({ statusCode: 422, statusMessage: 'Plage invalide', data: { errors: { base: 'Notation CIDR invalide' } } })
    if (pool.prefix < base.prefix) throw createError({ statusCode: 422, statusMessage: 'Taille de réseau plus grande que la plage', data: { errors: { prefix: `Au moins /${base.prefix}` } } })
    for (const [i, a] of pool.avoid.entries()) {
      const c = parseCidr(a)
      if (!c) throw createError({ statusCode: 422, statusMessage: 'Plage à éviter invalide', data: { errors: { [`avoid.${i}`]: 'Notation CIDR invalide' } } })
    }
    if (pool.avoid.map(parseCidr).some(c => c && within(base, c))) throw createError({ statusCode: 422, statusMessage: 'La plage est entièrement dans une plage à éviter', data: { errors: { base: 'Entièrement dans une plage à éviter' } } })
    pool = { ...pool, base: base.text, avoid: pool.avoid.map(a => parseCidr(a)!.text) }
  }
  await db().update(schema.serverEndpoints).set({ networkPool: pool }).where(eq(schema.serverEndpoints.id, endpointId))
  const allocs = await db().select().from(schema.networkAllocations).where(eq(schema.networkAllocations.endpointId, endpointId))
  const stale = allocs.filter(a => !fits(a.subnet, pool))
  for (const a of stale) await db().delete(schema.networkAllocations).where(eq(schema.networkAllocations.id, a.id))
  return { released: stale.length }
}

/** Attribution encore valable pour la plage (dedans, bonne taille, hors des plages à éviter). */
function fits(subnet: string, pool: NetworkPool | null): boolean {
  const c = parseCidr(subnet)
  const base = pool ? parseCidr(pool.base) : null
  if (!c || !base || !pool || !within(c, base)) return false
  return !pool.avoid.map(parseCidr).some(a => a && overlaps(c, a))
}

/**
 * Réseaux créés par la stack d'après le Compose : réseaux déclarés non externes, et le
 * réseau implicite « default » si un service y est rattaché.
 */
export function composeNetworkKeys(composeText: string): string[] {
  let doc: { services?: Record<string, { networks?: unknown, network_mode?: unknown } | null>, networks?: Record<string, { external?: unknown } | null> } | null
  try {
    doc = YAML.parse(composeText)
  }
  catch {
    return []
  }
  const keys = Object.entries(doc?.networks ?? {}).filter(([, d]) => !(d && d.external)).map(([k]) => k)
  const usesDefault = Object.values(doc?.services ?? {}).some((svc) => {
    if (!svc || svc.network_mode !== undefined) return false
    const n = svc.networks
    if (n === undefined || n === null) return true
    return Array.isArray(n) ? n.includes('default') : typeof n === 'object' && 'default' in (n as object)
  })
  if (usesDefault && !keys.includes('default')) keys.push('default')
  return keys
}

/**
 * Sous-réseaux des réseaux d'une cible (réseau → CIDR) ; vide si aucune plage n'est configurée.
 * Attributions existantes conservées, nouvelles enregistrées.
 */
export async function allocateSubnets(t: TargetRow, networkKeys: readonly string[], opts: { persist?: boolean } = {}): Promise<{ subnets: Record<string, string>, warnings: string[] }> {
  // Aperçu (reprise d'une stack, cible pas encore créée) : sous-réseaux calculés, rien d'enregistré.
  const persist = opts.persist ?? true
  const row = await endpointRow(t.endpoint.id)
  const pool = row.ep.networkPool
  const warnings: string[] = []
  if (!networkKeys.length) return { subnets: {}, warnings }
  // Attributions de la cible sur CET endpoint (une cible en cours de migration en a sur l'origine).
  const mine = (await db().select().from(schema.networkAllocations).where(eq(schema.networkAllocations.targetId, t.target.id))).filter(a => a.endpointId === t.endpoint.id)
  // Sans plage : seuls les sous-réseaux fixés à la main (plan d'adressage) s'appliquent.
  if (!pool) return { subnets: Object.fromEntries(mine.filter(a => networkKeys.includes(a.network)).map(a => [a.network, a.subnet])), warnings }
  const base = parseCidr(pool.base)!
  // Réseaux de l'hôte hors de cette stack (recréée) : une attribution faite alors que l'hôte était
  // injoignable peut chevaucher un réseau existant ; elle est alors refaite.
  const stack = stackOfTarget(t)
  const host = await hostSubnets(row)
  if (!host) warnings.push('Hôte injoignable : sous-réseaux de ses réseaux Docker non vérifiés')
  const hostTaken = (host ?? []).filter(h => !h.network.startsWith(`${stack}_`))
  const clash = (subnet: string) => {
    const c = parseCidr(subnet)
    return c ? hostTaken.find(h => { const x = parseCidr(h.subnet); return !!x && overlaps(c, x) }) : undefined
  }
  const subnets: Record<string, string> = {}
  for (const a of mine) {
    if (!networkKeys.includes(a.network) || !fits(a.subnet, pool)) continue
    const other = clash(a.subnet)
    if (other) warnings.push(`Réseau ${a.network} : ${a.subnet} chevauche le réseau ${other.network} (${other.subnet}) de l'hôte, nouveau sous-réseau attribué`)
    else subnets[a.network] = a.subnet
  }
  const missing = networkKeys.filter(k => !subnets[k])
  if (!missing.length) return { subnets, warnings }

  // Plages occupées : autres projets de l'endpoint, plages réservées, réseaux de l'hôte (sauf ceux de cette stack, recréés).
  // Les attributions des projets archivés sans stack sont libérées (en aperçu : seulement ignorées).
  const stale = new Set(persist ? await releaseStaleSubnets(t.endpoint.id, t.target.id) : (await staleAllocations(t.endpoint.id, t.target.id)).map(a => a.id))
  const others = (await db().select({ id: schema.networkAllocations.id, subnet: schema.networkAllocations.subnet }).from(schema.networkAllocations).where(eq(schema.networkAllocations.endpointId, t.endpoint.id)))
    .filter(o => !stale.has(o.id))
  const taken: Cidr[] = [
    ...others.map(o => o.subnet),
    ...pool.avoid,
    ...hostTaken.map(h => h.subnet),
  ].map(parseCidr).filter((c): c is Cidr => !!c)
  for (const key of missing) {
    const free = firstFree(base, pool.prefix, taken)
    if (!free) throw createError({ statusCode: 409, statusMessage: `Plage ${pool.base} épuisée : aucun /${pool.prefix} libre pour le réseau ${key} (agrandir la plage ou réduire la taille des réseaux)` })
    if (persist) {
      await db().delete(schema.networkAllocations).where(and(eq(schema.networkAllocations.targetId, t.target.id), eq(schema.networkAllocations.network, key)))
      await db().insert(schema.networkAllocations).values({ endpointId: t.endpoint.id, targetId: t.target.id, network: key, subnet: free.text })
    }
    subnets[key] = free.text
    taken.push(free)
  }
  return { subnets, warnings }
}

/**
 * Sous-réseau imposé pour un réseau de cible : remplace l'attribution existante. Fixé à la main
 * (plan d'adressage) par défaut ; `pinned: false` pour un sous-réseau simplement constaté sur l'hôte.
 */
export async function pinSubnet(endpointId: string, targetId: string, network: string, subnet: string, opts: { pinned?: boolean } = {}): Promise<void> {
  await db().transaction(async (tx) => {
    await tx.delete(schema.networkAllocations).where(and(eq(schema.networkAllocations.targetId, targetId), eq(schema.networkAllocations.network, network)))
    await tx.insert(schema.networkAllocations).values({ endpointId, targetId, network, subnet, pinned: opts.pinned ?? true })
  })
}

/** Libère les sous-réseaux attribués automatiquement à une cible (stack supprimée) ; ceux fixés à la main restent. */
export async function releaseTargetSubnets(targetId: string): Promise<number> {
  const rows = await db().delete(schema.networkAllocations)
    .where(and(eq(schema.networkAllocations.targetId, targetId), eq(schema.networkAllocations.pinned, false)))
    .returning({ id: schema.networkAllocations.id })
  return rows.length
}

/** Attributions automatiques de l'endpoint dont la cible n'a plus de stack ni de release active, dans un projet archivé. */
function staleAllocations(endpointId: string, exceptTargetId?: string) {
  const a = schema.networkAllocations
  const pt = schema.projectTargets
  return db().select({ id: a.id }).from(a)
    .innerJoin(pt, eq(pt.id, a.targetId))
    .innerJoin(schema.projects, eq(schema.projects.id, pt.projectId))
    .where(and(eq(a.endpointId, endpointId), eq(a.pinned, false), isNull(pt.portainerStackId), isNull(pt.currentReleaseId), isNotNull(schema.projects.archivedAt), exceptTargetId ? ne(a.targetId, exceptTargetId) : undefined))
}

/** Libère les attributions de `staleAllocations` (stacks supprimées avant que la libération n'existe). */
export async function releaseStaleSubnets(endpointId: string, exceptTargetId?: string): Promise<string[]> {
  const ids = (await staleAllocations(endpointId, exceptTargetId)).map(r => r.id)
  if (ids.length) await db().delete(schema.networkAllocations).where(inArray(schema.networkAllocations.id, ids))
  return ids
}
