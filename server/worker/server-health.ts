/** Contrôle périodique de tous les serveurs (agent ou SSH) : statut, endpoints, dernier message d'erreur. */
import { eq, inArray } from 'drizzle-orm'
import { db, schema } from '../db/client'
import { ensureProxyRouteNetworks } from '../services/proxy-routes'
import { checkServerHealth } from '../services/servers'
import { checkAllRunners } from '../services/runner-admin'

export async function checkAllServers(): Promise<Record<string, string>> {
  const servers = await db().select().from(schema.portainerServers)
  const results: Record<string, string> = {}
  // Séquentiel volontairement : un serveur lent ne doit pas saturer les connexions.
  for (const s of servers) {
    const r = await checkServerHealth(s)
    results[s.name] = r.status
  }
  // Runners des endpoints activés : joignabilité et espace disque.
  const runners = await checkAllRunners().catch((err: Error) => ({ erreur: err.message }))
  for (const [k, v] of Object.entries(runners)) results[`runner:${k}`] = v
  return results
}

/**
 * Conteneurs passés derrière le Traefik géré : rattachés de nouveau au réseau du proxy dès
 * qu'ils ont été recréés par leur Compose (vérification légère, hôtes avec routes uniquement).
 */
export async function reattachProxyRoutes(): Promise<Record<string, string>> {
  const results: Record<string, string> = {}
  const routed = [...new Set((await db().select({ endpointId: schema.proxyRoutes.endpointId }).from(schema.proxyRoutes)).map(r => r.endpointId))]
  if (!routed.length) return results
  const rows = await db().select({ ep: schema.serverEndpoints, server: schema.portainerServers }).from(schema.serverEndpoints)
    .innerJoin(schema.portainerServers, eq(schema.portainerServers.id, schema.serverEndpoints.serverId)).where(inArray(schema.serverEndpoints.id, routed))
  for (const row of rows) {
    const fixed = await ensureProxyRouteNetworks(row).catch((err: Error) => [`erreur : ${err.message}`])
    if (fixed.length) results[row.ep.name] = `rattachés : ${fixed.join(', ')}`
  }
  return results
}
