/**
 * Découverte (§5.3) : interroge l'agent, puis synchronise l'inventaire en base.
 *
 * Principes :
 * - la découverte ne modifie JAMAIS une décision d'administrateur (politique,
 *   rôle, description d'un réseau, activation d'un endpoint) ;
 * - un objet disparu est marqué `missing`, jamais supprimé : il peut être
 *   référencé par une configuration ou réapparaître ;
 * - un endpoint en erreur n'empêche pas la découverte des autres.
 */
import { type Progress, noProgress } from '../utils/progress'
import { and, eq, inArray } from 'drizzle-orm'
import type { DiscoveredEndpoint, DiscoveryPreview, NetworkDecision } from '../../shared/schemas/infra'
import { SYSTEM_NETWORKS } from '../../shared/schemas/infra'
import type { DiscoveryReport } from '../../shared/schemas/servers'
import { defaultNetworkDecision } from '../../shared/utils/networks'
import { proxyKindOf } from '../lib/proxy/others'
import type { DockerContainer, PortainerAdapter, PortainerConnection, PortainerStack } from '../adapters/portainer'
import { PortainerError, discoverEndpoint } from '../adapters/portainer'
import type { Db } from '../db/client'
import { schema } from '../db/client'
import type { EndpointInventory } from '../db/schema'

export { defaultNetworkDecision }

type Tx = Parameters<Parameters<Db['transaction']>[0]>[0]

// ---------------------------------------------------------------------------
// Fonctions pures
// ---------------------------------------------------------------------------

/** Compare deux versions x.y.z ; renvoie <0, 0 ou >0. */
export function compareVersions(a: string, b: string): number {
  const pa = a.split(/[.-]/).map(n => Number.parseInt(n, 10) || 0)
  const pb = b.split(/[.-]/).map(n => Number.parseInt(n, 10) || 0)
  for (let i = 0; i < 3; i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0)
    if (d !== 0) return d
  }
  return 0
}

/** Capacités déduites de la version et des endpoints (affichées et utilisées pour choisir les routes API). */
export function computeCapabilities(version: string, endpoints: { kind: string }[]): Record<string, boolean> {
  const kinds = {
    dockerStandalone: endpoints.some(e => e.kind === 'docker_standalone'),
    dockerSwarm: endpoints.some(e => e.kind === 'docker_swarm'),
    kubernetes: endpoints.some(e => e.kind === 'kubernetes'),
  }
  // Hôte joint en SSH : API Docker par le socket de l'hôte, fichiers par SFTP, sans agent ni Runner.
  if (/\(SSH\)$/.test(version)) return { dockerViaSsh: true, filesViaSftp: true, ...kinds }
  const atLeast = (v: string) => compareVersions(version, v) >= 0
  return {
    dockerProxy: true,
    stacksStandaloneString: atLeast('2.19.0'),
    stacksFromGit: atLeast('2.0.0'),
    systemVersionApi: atLeast('2.18.0'),
    dockerStandalone: endpoints.some(e => e.kind === 'docker_standalone'),
    dockerSwarm: endpoints.some(e => e.kind === 'docker_swarm'),
    kubernetes: endpoints.some(e => e.kind === 'kubernetes'),
  }
}

const TRAEFIK_IMAGE_RE = /(?:^|\/)traefik(?::|@|$)/

export function detectTraefik(containers: DockerContainer[]): EndpointInventory['traefik'] {
  const c = containers.find(x => x.state === 'running' && TRAEFIK_IMAGE_RE.test(x.image))
    ?? containers.find(x => TRAEFIK_IMAGE_RE.test(x.image))
  return c ? { container: c.names[0] ?? c.id.slice(0, 12), image: c.image, networks: c.networks.filter(n => !(SYSTEM_NETWORKS as readonly string[]).includes(n)) } : null
}

export function summarizeInventory(containers: DockerContainer[], imageCount: number, stacks: PortainerStack[], endpointId: number): EndpointInventory {
  return {
    containers: containers.length,
    running: containers.filter(c => c.state === 'running').length,
    images: imageCount,
    stacks: stacks.filter(s => s.endpointId === endpointId).length,
    traefik: detectTraefik(containers),
    proxies: detectProxies(containers),
    composeProjects: new Set(containers.map(c => c.labels['com.docker.compose.project']).filter(Boolean)).size,
  }
}

export function detectProxies(containers: DockerContainer[]): NonNullable<EndpointInventory['proxies']> {
  return containers.flatMap((c) => {
    const kind = proxyKindOf(c.image, (c.ports ?? []).filter(p => p.publicPort).map(p => p.privatePort))
    return kind ? [{ kind, container: c.names[0] ?? c.id.slice(0, 12), image: c.image }] : []
  })
}

export interface SyncPlan<K> {
  insert: K[]
  update: K[]
  missing: K[]
}

/** Diff entre clés connues en base et clés découvertes. */
export function planSync<K>(existing: Iterable<K>, discovered: Iterable<K>): SyncPlan<K> {
  const known = new Set(existing)
  const seen = new Set(discovered)
  return {
    insert: [...seen].filter(k => !known.has(k)),
    update: [...seen].filter(k => known.has(k)),
    missing: [...known].filter(k => !seen.has(k)),
  }
}

// ---------------------------------------------------------------------------
// Interrogation de l'agent
// ---------------------------------------------------------------------------

export async function discoverServer(adapter: PortainerAdapter, conn: PortainerConnection, progress: Progress = noProgress): Promise<DiscoveryPreview> {
  await progress.step(conn.transport === 'ssh' ? 'Connexion SSH et vérification de Docker' : 'Connexion à l\'agent et vérification de la version')
  const version = await adapter.getVersion(conn)
  if (!version.supported) throw new PortainerError(conn.transport === 'ssh' ? `${version.version} non supporté (Docker 20 ou plus récent requis)` : `Agent Portainer ${version.version} non supporté (2.x requis)`, 'unsupported')

  await progress.step('Lecture de l\'hôte et des stacks')
  const [endpoints, stacks] = await Promise.all([
    adapter.listEndpoints(conn),
    adapter.listStacks(conn).catch(() => [] as PortainerStack[]),
  ])

  // Inventaire des endpoints en parallèle ; l'avancement suit ceux qui sont terminés.
  let finished = 0
  const total = endpoints.length
  await progress.step(`Inventaire des endpoints (0/${total})`, 0, total)
  const tick = async (name: string) => { finished++; await progress.step(`Inventaire des endpoints (${finished}/${total}) : ${name} lu`, finished, total) }
  const discovered = await Promise.all(endpoints.map(async (ep): Promise<DiscoveredEndpoint> => {
    const r = await inventoryOf(ep)
    await tick(ep.name)
    return r
  }))
  async function inventoryOf(ep: (typeof endpoints)[number]): Promise<DiscoveredEndpoint> {
    const base = {
      id: ep.id,
      name: ep.name,
      kind: ep.kind,
      url: ep.url,
      online: ep.online,
      supported: ep.kind === 'docker_standalone',
    }
    const empty = { networks: [], volumes: [], inventory: { containers: 0, running: 0, images: 0, stacks: 0, traefik: null } }
    // Kubernetes n'expose pas d'API Docker ; un endpoint hors ligne ne répondra pas.
    if (ep.kind === 'kubernetes' || ep.kind === 'other') return { ...base, ...empty }
    if (!ep.online) return { ...base, ...empty, error: 'Endpoint hors ligne' }
    try {
      const d = await discoverEndpoint(adapter, conn, ep)
      return {
        ...base,
        networks: d.networks.map(n => ({
          id: n.id, name: n.name, driver: n.driver, scope: n.scope, internal: n.internal, attachable: n.attachable, labels: n.labels,
          // Stacks attachées : un réseau Compose utilisé par une autre stack est partagé (décision de l'administrateur).
          stacks: [...new Set(d.containers.filter(c => c.networks.includes(n.name)).map(c => c.labels['com.docker.compose.project'] ?? `(${c.names[0] ?? c.id.slice(0, 12)})`))],
        })),
        volumes: d.volumes.map(v => ({ name: v.name, driver: v.driver, mountpoint: v.mountpoint })),
        inventory: summarizeInventory(d.containers, d.images.length, stacks, ep.id),
      }
    }
    catch (err) {
      return { ...base, ...empty, error: err instanceof Error ? err.message : 'Erreur de découverte' }
    }
  }

  return {
    version: version.version,
    capabilities: computeCapabilities(version.version, endpoints),
    endpoints: discovered,
  }
}

// ---------------------------------------------------------------------------
// Synchronisation en base
// ---------------------------------------------------------------------------

export interface SyncResult {
  report: DiscoveryReport
  /** portainerEndpointId → id interne de l'endpoint. */
  endpointIds: Map<number, string>
}

/**
 * Écrit le résultat d'une découverte. `decisions` permet à l'assistant de
 * fixer la politique des réseaux à leur création ; elle n'est jamais
 * appliquée à un réseau déjà connu.
 */
export async function syncInventory(
  tx: Tx,
  serverId: string,
  preview: DiscoveryPreview,
  decisions: Map<number, Record<string, NetworkDecision>> = new Map(),
  environmentIdByKey: Map<string, string> = new Map(),
): Promise<SyncResult> {
  const report: DiscoveryReport = {
    endpoints: { added: 0, updated: 0, missing: 0 },
    networks: { added: 0, updated: 0, missing: 0 },
    volumes: { added: 0, updated: 0, missing: 0 },
    errors: [],
  }
  const now = new Date()

  await tx.update(schema.portainerServers).set({
    detectedVersion: preview.version,
    capabilities: preview.capabilities,
    lastDiscoveryAt: now,
  }).where(eq(schema.portainerServers.id, serverId))

  // --- Endpoints ---
  const existing = await tx.select().from(schema.serverEndpoints).where(eq(schema.serverEndpoints.serverId, serverId))
  const byPortainerId = new Map(existing.map(e => [e.portainerEndpointId, e]))
  const plan = planSync(byPortainerId.keys(), preview.endpoints.map(e => e.id))
  const endpointIds = new Map<number, string>()

  for (const ep of preview.endpoints) {
    const values = {
      name: ep.name,
      type: (['docker_standalone', 'docker_swarm', 'kubernetes'].includes(ep.kind) ? ep.kind : 'other') as 'docker_standalone',
      url: ep.url,
      online: ep.online,
      missing: false,
      discoveredAt: now,
      // Un endpoint en erreur garde son inventaire précédent.
      ...(ep.error ? {} : { inventory: ep.inventory }),
    }
    const known = byPortainerId.get(ep.id)
    if (known) {
      await tx.update(schema.serverEndpoints).set(values).where(eq(schema.serverEndpoints.id, known.id))
      endpointIds.set(ep.id, known.id)
      report.endpoints.updated++
    }
    else {
      const [row] = await tx.insert(schema.serverEndpoints).values({ ...values, serverId, portainerEndpointId: ep.id, inventory: ep.inventory }).returning({ id: schema.serverEndpoints.id })
      endpointIds.set(ep.id, row!.id)
      report.endpoints.added++
    }
    if (ep.error) report.errors.push({ endpoint: ep.name, error: ep.error })
  }
  if (plan.missing.length) {
    await tx.update(schema.serverEndpoints).set({ missing: true, online: false })
      .where(and(eq(schema.serverEndpoints.serverId, serverId), inArray(schema.serverEndpoints.portainerEndpointId, plan.missing)))
    report.endpoints.missing += plan.missing.length
  }

  // --- Réseaux et volumes, par endpoint interrogé avec succès ---
  for (const ep of preview.endpoints) {
    if (ep.error || ep.kind === 'kubernetes' || ep.kind === 'other') continue
    const endpointId = endpointIds.get(ep.id)!
    const epDecisions = decisions.get(ep.id) ?? {}
    const traefikNetworks = ep.inventory.traefik?.networks ?? []

    const knownNets = await tx.select({ id: schema.networks.id, name: schema.networks.name }).from(schema.networks).where(eq(schema.networks.endpointId, endpointId))
    const netPlan = planSync(knownNets.map(n => n.name), ep.networks.map(n => n.name))
    for (const n of ep.networks) {
      const meta = { dockerId: n.id, name: n.name, driver: n.driver, scope: n.scope, internal: n.internal, labels: n.labels, missing: false, discoveredAt: now }
      if (netPlan.update.includes(n.name)) {
        await tx.update(schema.networks).set(meta).where(and(eq(schema.networks.endpointId, endpointId), eq(schema.networks.name, n.name)))
        report.networks.updated++
      }
      else {
        const d = epDecisions[n.name] ?? defaultNetworkDecision(n, traefikNetworks)
        await tx.insert(schema.networks).values({
          ...meta,
          endpointId,
          policy: d.policy,
          role: d.role,
          external: d.external,
          description: d.description,
          tags: d.tags,
          allowedEnvironmentIds: d.allowedEnvironmentKeys.map(k => environmentIdByKey.get(k)).filter((x): x is string => !!x),
        })
        report.networks.added++
      }
    }
    if (netPlan.missing.length) {
      await tx.update(schema.networks).set({ missing: true }).where(and(eq(schema.networks.endpointId, endpointId), inArray(schema.networks.name, netPlan.missing)))
      report.networks.missing += netPlan.missing.length
    }

    const knownVols = await tx.select({ name: schema.dockerVolumes.name }).from(schema.dockerVolumes).where(eq(schema.dockerVolumes.endpointId, endpointId))
    const volPlan = planSync(knownVols.map(v => v.name), ep.volumes.map(v => v.name))
    for (const v of ep.volumes) {
      const meta = { name: v.name, driver: v.driver, mountpoint: v.mountpoint, missing: false, discoveredAt: now }
      if (volPlan.update.includes(v.name)) {
        await tx.update(schema.dockerVolumes).set(meta).where(and(eq(schema.dockerVolumes.endpointId, endpointId), eq(schema.dockerVolumes.name, v.name)))
        report.volumes.updated++
      }
      else {
        await tx.insert(schema.dockerVolumes).values({ ...meta, endpointId })
        report.volumes.added++
      }
    }
    if (volPlan.missing.length) {
      await tx.update(schema.dockerVolumes).set({ missing: true }).where(and(eq(schema.dockerVolumes.endpointId, endpointId), inArray(schema.dockerVolumes.name, volPlan.missing)))
      report.volumes.missing += volPlan.missing.length
    }
  }

  return { report, endpointIds }
}
