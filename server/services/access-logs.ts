/**
 * Logs d'accès des reverse proxies nginx : dernières lignes de la sortie du conteneur, analysées
 * (format de la console, nginx-proxy, combined), filtrées (domaines, statuts, recherche) puis
 * résumées. Rien n'est conservé par la console : lecture à la demande.
 */
import { eq } from 'drizzle-orm'
import { createError } from 'h3'
import { type AccessEntry, type AccessError, type AccessStats, type StatusClass, accessStats, parseAccessLine, parseErrorLine, statusClass } from '../../shared/utils/access-log'
import { portainer } from '../adapters/portainer'
import { db, schema } from '../db/client'
import type { EndpointRow } from './live'
import { proxyConfigFor } from './nginx-certificates'
import type { TargetRow } from './projects'
import { connectionFor } from './servers'

export interface AccessLogQuery {
  tail: number
  hosts?: string[]
  status?: StatusClass
  search?: string
  limit: number
}

export interface AccessLogResult {
  container: string
  scannedLines: number
  unparsed: number
  formats: Record<AccessEntry['format'], number>
  /** Domaines vus (filtre), hors filtre. */
  hosts: string[]
  entries: AccessEntry[]
  stats: AccessStats
  errors: AccessError[]
  /** Aucune ligne au format de la console alors que le proxy est piloté (journal à activer). */
  hint: string | null
}

const matches = (e: AccessEntry, q: AccessLogQuery, hosts: Set<string> | null) => {
  if (hosts && (!e.host || !hosts.has(e.host))) return false
  if (q.status && statusClass(e.status) !== q.status) return false
  if (q.search) {
    const s = q.search.toLowerCase()
    return [e.path, e.remote, e.agent, e.method, e.host, String(e.status)].some(x => x?.toLowerCase().includes(s))
  }
  return true
}

export async function readAccessLogs(row: Pick<EndpointRow, 'server' | 'ep'>, containerId: string, q: AccessLogQuery, opts: { managedNginx?: boolean } = {}): Promise<AccessLogResult> {
  const conn = await connectionFor(row.server)
  const p = portainer()
  const containers = await p.listContainers(conn, row.ep.portainerEndpointId)
  const c = containers.find(x => x.id === containerId || x.id.startsWith(containerId) || x.names.includes(containerId))
  if (!c) throw createError({ statusCode: 404, statusMessage: 'Conteneur du proxy introuvable' })
  const lines = await p.containerLogs(conn, row.ep.portainerEndpointId, c.id, q.tail)
  const all: AccessEntry[] = []
  const errors: AccessError[] = []
  let unparsed = 0
  for (const l of lines) {
    if (!l.trim()) continue
    const e = parseAccessLine(l)
    if (e) {
      all.push(e)
      continue
    }
    const err = parseErrorLine(l)
    if (err) errors.push(err)
    else unparsed++
  }
  const formats = { console: 0, vhost: 0, combined: 0 }
  for (const e of all) formats[e.format]++
  const hostFilter = q.hosts?.length ? new Set(q.hosts.map(h => h.toLowerCase())) : null
  const filtered = all.filter(e => matches(e, q, hostFilter))
  const name = (c.names[0] ?? c.id.slice(0, 12)).replace(/^\//, '')
  return {
    container: name,
    scannedLines: lines.length,
    unparsed,
    formats,
    hosts: [...new Set(all.map(e => e.host).filter((h): h is string => !!h))].sort(),
    entries: filtered.slice(-q.limit).reverse(),
    stats: accessStats(filtered),
    errors: errors.filter(e => !hostFilter || !e.host || hostFilter.has(e.host)).slice(-50).reverse(),
    hint: opts.managedNginx && all.length && !formats.console
      ? 'Aucune ligne au format de la console : choisir « Journal d\'accès des sites : format de la console » (onglet Reverse proxy) puis redéployer les projets pour voir domaines et durées'
      : !all.length && lines.length ? 'Aucune ligne de journal d\'accès reconnue dans la sortie du conteneur (journal écrit dans un fichier ?)' : null,
  }
}

/** Logs d'accès d'une cible : domaines de ses expositions, servis par le nginx déclaré de son environnement. */
export async function targetAccessLogs(t: TargetRow, q: AccessLogQuery): Promise<AccessLogResult> {
  const rows = await db().select().from(schema.traefikConfigs).where(eq(schema.traefikConfigs.endpointId, t.target.endpointId))
  const cfg = proxyConfigFor(rows, t.env.id)
  if (!cfg || cfg.provider === 'traefik') throw createError({ statusCode: 409, statusMessage: 'Logs d\'accès : disponibles quand les projets sont servis par nginx (onglet Reverse proxy du serveur)' })
  if (!cfg.nginxContainer) throw createError({ statusCode: 409, statusMessage: 'Conteneur nginx-proxy non déclaré (onglet Reverse proxy du serveur)' })
  const hosts = [...new Set(t.target.exposures.map(e => e.host.toLowerCase()))]
  if (!hosts.length) throw createError({ statusCode: 409, statusMessage: 'Aucune exposition web pour cette cible' })
  const [row] = await db().select({ ep: schema.serverEndpoints, server: schema.portainerServers }).from(schema.serverEndpoints)
    .innerJoin(schema.portainerServers, eq(schema.portainerServers.id, schema.serverEndpoints.serverId))
    .where(eq(schema.serverEndpoints.id, t.target.endpointId))
  if (!row) throw createError({ statusCode: 404, statusMessage: 'Endpoint introuvable' })
  const wanted = q.hosts?.length ? q.hosts.filter(h => hosts.includes(h.toLowerCase())) : hosts
  const r = await readAccessLogs(row, cfg.nginxContainer, { ...q, hosts: wanted.length ? wanted : hosts }, { managedNginx: cfg.provider === 'nginx' })
  return { ...r, hosts: r.hosts.filter(h => hosts.includes(h)) }
}
