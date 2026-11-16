/**
 * Routes du Traefik géré vers des conteneurs non déployés par la plateforme
 * (« passer derrière le reverse proxy » depuis la carte des proxies).
 *
 * - Le conteneur est rattaché au réseau du Traefik géré par la plateforme, puis
 *   rattaché de nouveau s'il est recréé (contrôle périodique et à chaque application).
 * - Les routes sont écrites dans la configuration dynamique du Traefik géré
 *   (fournisseur fichier) ; elles prennent effet à l'application du proxy.
 * - Une stack de la plateforme n'est jamais routée ainsi : elle passe par
 *   l'exposition web de son projet (labels générés au déploiement).
 */
import { createHash } from 'node:crypto'
import { and, eq } from 'drizzle-orm'
import { createError } from 'h3'
import type { ProxyRouteDto, ProxyRouteInput } from '../../shared/schemas/proxy-routes'
import { HOSTNAME_RE, PATH_PREFIX_RE, isAllowedHost, normalizeHost } from '../../shared/utils/domains'
import { type DockerContainer, portainer } from '../adapters/portainer'
import { db, schema } from '../db/client'
import type { ManagedRoute } from '../lib/proxy/managed'
import { audit } from '../utils/audit'
import type { AuthUser } from '../utils/auth'
import type { EndpointRow } from './live'
import { endpointTopology } from './proxy'
import { connectionFor } from './servers'

type RouteRow = typeof schema.proxyRoutes.$inferSelect

const nameOf = (c: DockerContainer) => (c.names[0] ?? c.id.slice(0, 12)).replace(/^\//, '')

/** Conteneur actuel d'une route : même projet et service Compose (stable d'une recréation à l'autre), sinon même nom. */
export function containerForRoute(route: Pick<RouteRow, 'stack' | 'service' | 'containerName'>, containers: readonly DockerContainer[]): DockerContainer | null {
  const byCompose = route.stack && route.service
    ? containers.filter(c => c.labels['com.docker.compose.project'] === route.stack && c.labels['com.docker.compose.service'] === route.service)
    : []
  return byCompose.find(c => c.state === 'running') ?? byCompose[0] ?? containers.find(c => nameOf(c) === route.containerName) ?? null
}

async function managedNetwork(endpointId: string): Promise<string> {
  const [mp] = await db().select({ config: schema.managedProxies.config }).from(schema.managedProxies).where(eq(schema.managedProxies.endpointId, endpointId))
  if (!mp) throw createError({ statusCode: 409, statusMessage: 'Aucun Traefik géré sur cet hôte : le créer d\'abord (configuration du serveur, onglet Proxy)' })
  return mp.config.networks[0]!
}

/** Domaines déjà servis sur l'endpoint : routes existantes, expositions des projets, routes lues sur les proxies. */
async function takenHosts(row: EndpointRow): Promise<Map<string, string>> {
  const taken = new Map<string, string>()
  const key = (h: string, p: string | null) => `${normalizeHost(h)}${p ?? ''}`
  for (const r of await db().select().from(schema.proxyRoutes).where(eq(schema.proxyRoutes.endpointId, row.ep.id))) taken.set(key(r.host, r.pathPrefix), `route vers ${r.containerName}`)
  const targets = await db().select({ exposures: schema.projectTargets.exposures, slug: schema.projects.slug }).from(schema.projectTargets)
    .innerJoin(schema.projects, eq(schema.projects.id, schema.projectTargets.projectId)).where(eq(schema.projectTargets.endpointId, row.ep.id))
  for (const t of targets) for (const e of t.exposures) taken.set(key(e.host, e.pathPrefix), `projet ${t.slug}`)
  const topo = await endpointTopology(row).catch(() => null)
  for (const r of topo?.routes ?? []) for (const h of r.hosts) if (!taken.has(key(h, r.pathPrefix ?? null))) taken.set(key(h, r.pathPrefix ?? null), r.container ? `${r.container.stack ?? r.container.name}` : 'un autre proxy')
  return taken
}

export async function listProxyRoutes(row: EndpointRow): Promise<ProxyRouteDto[]> {
  const routes = await db().select().from(schema.proxyRoutes).where(eq(schema.proxyRoutes.endpointId, row.ep.id))
  if (!routes.length) return []
  const containers = await portainer().listContainers(await connectionFor(row.server), row.ep.portainerEndpointId).catch(() => [])
  const [mp] = await db().select({ appliedRoutes: schema.managedProxies.appliedRoutes }).from(schema.managedProxies).where(eq(schema.managedProxies.endpointId, row.ep.id))
  return routes.map((r) => {
    const c = containerForRoute(r, containers)
    return {
      id: r.id, stack: r.stack, service: r.service, containerName: c ? nameOf(c) : r.containerName, host: r.host, pathPrefix: r.pathPrefix, port: r.port, https: r.https, network: r.network,
      containerFound: !!c, attached: !!c?.networks.includes(r.network),
      applied: (mp?.appliedRoutes ?? []).includes(routeSignature(r)),
      publishedPorts: (c?.ports ?? []).filter(p => p.publicPort).map(p => `${p.ip && p.ip !== '0.0.0.0' ? p.ip : '0.0.0.0'}:${p.publicPort}→${p.privatePort}`),
    }
  })
}

export async function createProxyRoutes(row: EndpointRow, inputs: ProxyRouteInput[], user: AuthUser): Promise<ProxyRouteDto[]> {
  const network = await managedNetwork(row.ep.id)
  const conn = await connectionFor(row.server)
  const containers = await portainer().listContainers(conn, row.ep.portainerEndpointId)
  const taken = await takenHosts(row)
  const [tc] = await db().select({ allowedDomains: schema.traefikConfigs.allowedDomains }).from(schema.traefikConfigs).where(eq(schema.traefikConfigs.endpointId, row.ep.id)).limit(1)
  const allowed = tc?.allowedDomains ?? []
  // Stacks gérées par un projet (une stack détachée redevient externe).
  const managedStacks = new Set((await db().select({ s: schema.projectTargets.stackName }).from(schema.projectTargets).where(eq(schema.projectTargets.endpointId, row.ep.id))).map(r => r.s))
  const errors: string[] = []
  const planned: { input: ProxyRouteInput, c: DockerContainer }[] = []
  const seen = new Set<string>()
  for (const input of inputs) {
    const c = containers.find(x => x.id === input.containerId || x.id.startsWith(input.containerId))
    const host = normalizeHost(input.host)
    const k = `${host}${input.pathPrefix ?? ''}`
    if (!c) errors.push(`${input.containerId.slice(0, 12)} : conteneur introuvable sur l'hôte`)
    else if (c.labels['platform.managed'] === 'true' && managedStacks.has(c.labels['com.docker.compose.project'] ?? null)) errors.push(`${nameOf(c)} : stack de la plateforme, à exposer depuis l'onglet Exposition web de son projet`)
    else if (!HOSTNAME_RE.test(host)) errors.push(`${host} : nom d'hôte invalide`)
    else if (allowed.length && !isAllowedHost(host, allowed)) errors.push(`${host} : domaine non autorisé sur cet endpoint (autorisés : ${allowed.join(', ')})`)
    else if (input.pathPrefix && !PATH_PREFIX_RE.test(input.pathPrefix)) errors.push(`${input.pathPrefix} : préfixe de chemin invalide`)
    else if (taken.has(k) || seen.has(k)) errors.push(`${host}${input.pathPrefix ?? ''} : déjà servi (${taken.get(k) ?? 'demandé deux fois'})`)
    else planned.push({ input: { ...input, host }, c })
    seen.add(k)
  }
  if (errors.length) throw createError({ statusCode: 422, statusMessage: errors.join(' ; ') })

  for (const { input, c } of planned) {
    const attachedByPlatform = !c.networks.includes(network)
    if (attachedByPlatform) await portainer().connectNetwork(conn, row.ep.portainerEndpointId, network, c.id)
    const [r] = await db().insert(schema.proxyRoutes).values({
      endpointId: row.ep.id, stack: c.labels['com.docker.compose.project'] ?? null, service: c.labels['com.docker.compose.service'] ?? null,
      containerName: nameOf(c), host: input.host, pathPrefix: input.pathPrefix ?? null, port: input.port, https: input.https, network, attachedByPlatform, createdBy: user.id,
    }).returning()
    await audit({ actorUserId: user.id, actorLabel: user.email, action: 'proxy_route.create', targetType: 'proxy_route', targetId: r!.id, serverId: row.server.id, outcome: 'success', details: { container: nameOf(c), host: input.host, pathPrefix: input.pathPrefix ?? null, port: input.port, https: input.https, network, attachedByPlatform } })
  }
  return listProxyRoutes(row)
}

export async function deleteProxyRoute(row: EndpointRow, routeId: string, user: AuthUser): Promise<void> {
  const [r] = await db().select().from(schema.proxyRoutes).where(and(eq(schema.proxyRoutes.id, routeId), eq(schema.proxyRoutes.endpointId, row.ep.id)))
  if (!r) throw createError({ statusCode: 404, statusMessage: 'Route introuvable' })
  await db().delete(schema.proxyRoutes).where(eq(schema.proxyRoutes.id, r.id))
  // Détaché seulement si la plateforme l'avait rattaché et qu'aucune autre route ne l'utilise.
  const others = await db().select({ id: schema.proxyRoutes.id }).from(schema.proxyRoutes)
    .where(and(eq(schema.proxyRoutes.endpointId, row.ep.id), eq(schema.proxyRoutes.containerName, r.containerName)))
  let detached = false
  if (r.attachedByPlatform && !others.length) {
    const conn = await connectionFor(row.server)
    const c = containerForRoute(r, await portainer().listContainers(conn, row.ep.portainerEndpointId).catch(() => []))
    if (c?.networks.includes(r.network)) {
      await portainer().disconnectNetwork(conn, row.ep.portainerEndpointId, r.network, c.id).catch(() => {})
      detached = true
    }
  }
  await audit({ actorUserId: user.id, actorLabel: user.email, action: 'proxy_route.delete', targetType: 'proxy_route', targetId: r.id, serverId: row.server.id, outcome: 'success', details: { container: r.containerName, host: r.host, detached } })
}

/** Rattache de nouveau au réseau du proxy les conteneurs routés qui l'ont perdu (recréation par leur Compose). */
export async function ensureProxyRouteNetworks(row: EndpointRow): Promise<string[]> {
  const routes = await db().select().from(schema.proxyRoutes).where(eq(schema.proxyRoutes.endpointId, row.ep.id))
  if (!routes.length) return []
  const conn = await connectionFor(row.server)
  const containers = await portainer().listContainers(conn, row.ep.portainerEndpointId)
  const fixed: string[] = []
  for (const r of routes) {
    const c = containerForRoute(r, containers)
    if (!c || c.networks.includes(r.network)) continue
    await portainer().connectNetwork(conn, row.ep.portainerEndpointId, r.network, c.id)
    c.networks.push(r.network)
    fixed.push(nameOf(c))
    await audit({ actorLabel: 'system', action: 'proxy_route.reattach', targetType: 'proxy_route', targetId: r.id, serverId: row.server.id, outcome: 'success', details: { container: nameOf(c), network: r.network } })
  }
  return fixed
}

/** Empreinte d'une route (ce qui est écrit dans la configuration du proxy). */
export const routeSignature = (r: Pick<RouteRow, 'id' | 'containerName' | 'host' | 'pathPrefix' | 'port' | 'https'>) =>
  createHash('sha256').update(JSON.stringify([r.id, r.containerName, r.host, r.pathPrefix, r.port, r.https])).digest('hex').slice(0, 16)

/** Routes à écrire dans la configuration du Traefik géré, et leurs empreintes. */
export async function routesForApply(endpointId: string): Promise<{ routes: ManagedRoute[], applied: string[] }> {
  const rows = await db().select().from(schema.proxyRoutes).where(eq(schema.proxyRoutes.endpointId, endpointId)).orderBy(schema.proxyRoutes.createdAt)
  return { routes: rows.map(r => ({ id: r.id, containerName: r.containerName, host: r.host, pathPrefix: r.pathPrefix, port: r.port, https: r.https })), applied: rows.map(routeSignature).sort() }
}
