/**
 * Lecture en direct des conteneurs des endpoints gérés, via l'API Docker de
 * l'agent Portainer de chaque hôte (aucune action, aucune donnée stockée). Un cache de 2 s, partagé et
 * à requête unique, évite de multiplier les appels quand plusieurs écrans regardent
 * le même endpoint.
 */
import { and, eq, inArray } from 'drizzle-orm'
import type { LiveContainer, LiveEndpoint, LiveHealth, LiveState } from '../../shared/schemas/live'
import { portainer } from '../adapters/portainer'
import { db, schema } from '../db/client'
import { type AuthUser, canOn } from '../utils/auth'
import { flatFromLabels } from '../lib/proxy/flat'
import { caddyLabelRoutes } from '../lib/proxy/others'
import { interpretDynamic, parseRule } from '../lib/proxy/traefik'
import { connectionFor } from './servers'
import { byCode } from '../../shared/utils/compare'

const TTL_MS = 2_000
const cache = new Map<string, { at: number, value: Promise<LiveEndpoint> }>()

export type EndpointRow = { ep: typeof schema.serverEndpoints.$inferSelect, server: typeof schema.portainerServers.$inferSelect }

/** Endpoints gérés visibles : activés, présents, sur un serveur lisible par l'utilisateur. */
export async function liveEndpoints(user: AuthUser, endpointId?: string): Promise<EndpointRow[]> {
  const rows = await db().select({ ep: schema.serverEndpoints, server: schema.portainerServers }).from(schema.serverEndpoints)
    .innerJoin(schema.portainerServers, eq(schema.portainerServers.id, schema.serverEndpoints.serverId))
    .where(endpointId ? eq(schema.serverEndpoints.id, endpointId) : and(eq(schema.serverEndpoints.enabled, true), eq(schema.serverEndpoints.missing, false)))
  return rows.filter(r => canOn(user, 'server:read', { serverId: r.server.id }))
}

/** Domaines annoncés par les labels (lecture seule, sans la configuration du proxy). */
export function labelHosts(labels: Record<string, string>): string[] {
  const hosts = new Set<string>()
  if (Object.keys(labels).some(k => k.startsWith('traefik.'))) {
    for (const r of interpretDynamic(flatFromLabels(labels, 'traefik.')).routers) for (const h of parseRule(r.rule).hosts) hosts.add(h)
  }
  for (const r of caddyLabelRoutes(labels)) for (const h of r.hosts) hosts.add(h)
  return [...hosts].sort(byCode)
}

export function healthOf(status: string): LiveHealth {
  if (/\(healthy\)/.test(status)) return 'healthy'
  if (/\(unhealthy\)/.test(status)) return 'unhealthy'
  if (/\(health: starting\)/.test(status)) return 'starting'
  return null
}

async function scan(row: EndpointRow): Promise<LiveEndpoint> {
  const t = Date.now()
  const base = { endpointId: row.ep.id, endpointName: row.ep.name, serverId: row.server.id, serverName: row.server.name }
  try {
    const conn = await connectionFor(row.server)
    const p = portainer()
    const [containers, engine] = await Promise.all([
      p.listContainers(conn, row.ep.portainerEndpointId),
      p.engineInfo(conn, row.ep.portainerEndpointId),
    ])
    // Rattachement aux projets : stacks déployées par la plateforme sur cet endpoint.
    const stacks = [...new Set(containers.map(c => c.labels['com.docker.compose.project']).filter(Boolean))] as string[]
    const targets = stacks.length
      ? await db().select({ stack: schema.projectTargets.stackName, targetId: schema.projectTargets.id, id: schema.projects.id, name: schema.projects.name, environment: schema.environments.name })
        .from(schema.projectTargets)
        .innerJoin(schema.projects, eq(schema.projects.id, schema.projectTargets.projectId))
        .innerJoin(schema.environments, eq(schema.environments.id, schema.projectTargets.environmentId))
        .where(and(eq(schema.projectTargets.endpointId, row.ep.id), inArray(schema.projectTargets.stackName, stacks)))
      : []
    const out: LiveContainer[] = containers.map((c) => {
      const stack = c.labels['com.docker.compose.project'] ?? null
      const target = stack ? targets.find(x => x.stack === stack) : undefined
      return {
        id: c.id,
        name: c.names[0] ?? c.id.slice(0, 12),
        image: c.image,
        state: c.state as LiveState,
        status: c.status,
        health: healthOf(c.status),
        createdAt: c.createdAt,
        command: c.command ?? null,
        ports: c.ports ?? [],
        mounts: c.mounts ?? [],
        networks: c.networks,
        hosts: labelHosts(c.labels),
        stack,
        service: c.labels['com.docker.compose.service'] ?? null,
        managed: c.labels['platform.managed'] === 'true',
        project: target ? { id: target.id, name: target.name, environment: target.environment, targetId: target.targetId } : null,
      }
    }).sort((a, b) => (a.stack ?? '~').localeCompare(b.stack ?? '~') || a.name.localeCompare(b.name))
    return { ...base, scannedAt: new Date().toISOString(), durationMs: Date.now() - t, ok: true, error: null, engine: { containers: engine.containers, running: engine.running, paused: engine.paused, stopped: engine.stopped, images: engine.images, serverVersion: engine.serverVersion, os: engine.os, cpus: engine.cpus, memoryBytes: engine.memoryBytes, name: engine.name }, containers: out }
  }
  catch (err) {
    return { ...base, scannedAt: new Date().toISOString(), durationMs: Date.now() - t, ok: false, error: (err as Error).message, engine: null, containers: [] }
  }
}

/** Lecture d'un endpoint (partagée 2 s entre les demandes simultanées). */
export function scanEndpoint(row: EndpointRow): Promise<LiveEndpoint> {
  const hit = cache.get(row.ep.id)
  if (hit && Date.now() - hit.at < TTL_MS) return hit.value
  const value = scan(row)
  cache.set(row.ep.id, { at: Date.now(), value })
  return value
}

/** Endpoint et projet d'un conteneur, pour le détail. */
export async function projectOfStack(endpointId: string, stack: string | null) {
  if (!stack) return null
  const [t] = await db().select({ id: schema.projects.id, name: schema.projects.name, environment: schema.environments.name, targetId: schema.projectTargets.id }).from(schema.projectTargets)
    .innerJoin(schema.projects, eq(schema.projects.id, schema.projectTargets.projectId))
    .innerJoin(schema.environments, eq(schema.environments.id, schema.projectTargets.environmentId))
    .where(and(eq(schema.projectTargets.endpointId, endpointId), eq(schema.projectTargets.stackName, stack)))
  return t ?? null
}
