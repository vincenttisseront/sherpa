import { and, asc, count, desc, eq, gte, ilike, inArray, lte, or, sql, type SQL } from 'drizzle-orm'
import type { Paginated } from '../../../shared/schemas/common'
import type { ServerDto } from '../../../shared/schemas/servers'
import { serverListQuery } from '../../../shared/schemas/servers'
import { db, schema } from '../../db/client'
import { requireAnyPermission } from '../../utils/auth'
import { visibleServerIds } from '../../services/access'
import { type CsvColumn, periodRange, tableResponse } from '../../utils/table'
import type { z } from 'zod'

defineRouteMeta({
  openAPI: { tags: ['servers'], summary: 'Liste paginée des serveurs (sans secrets)' },
})

const SORTABLE = {
  name: schema.portainerServers.name,
  status: schema.portainerServers.status,
  createdAt: schema.portainerServers.createdAt,
  lastCheckedAt: schema.portainerServers.lastCheckedAt,
} as const

const CSV: CsvColumn<ServerDto>[] = [
  { key: 'name', label: 'Nom', value: r => r.name },
  { key: 'url', label: 'URL', value: r => r.url },
  { key: 'status', label: 'Statut', value: r => r.status },
  { key: 'detectedVersion', label: 'Version', value: r => r.detectedVersion },
  { key: 'endpointCount', label: 'Endpoints', value: r => r.endpointCount },
  { key: 'tags', label: 'Tags', value: r => r.tags },
  { key: 'lastCheckedAt', label: 'Dernier contrôle', value: r => r.lastCheckedAt },
  { key: 'lastError', label: 'Dernière erreur', value: r => r.lastError },
  { key: 'createdAt', label: 'Créé le', value: r => r.createdAt },
]

export default defineEventHandler(async (event) => {
  const user = await requireAnyPermission(event, 'server:read')
  const visible = await visibleServerIds(user, 'server:read')
  const q = await getValidatedQuery(event, serverListQuery.parse)
  return tableResponse(event, q, x => listServers(x, visible), { name: 'serveurs', columns: CSV, user })
})

async function listServers(q: z.infer<typeof serverListQuery>, visible: string[] | null): Promise<Paginated<ServerDto>> {
  const s = schema.portainerServers

  const filters: SQL[] = []
  if (q.q) filters.push(or(ilike(s.name, `%${q.q}%`), ilike(s.url, `%${q.q}%`))!)
  if (q.status) filters.push(eq(s.status, q.status))
  if (visible) filters.push(visible.length ? inArray(s.id, visible) : sql`false`)
  const { from, to } = periodRange(q)
  if (from) filters.push(gte(s.createdAt, from))
  if (to) filters.push(lte(s.createdAt, to))
  const where = filters.length ? and(...filters) : undefined

  const [sortKey, sortDir] = (q.sort ?? 'name:asc').split(':') as [string, 'asc' | 'desc']
  const sortCol = SORTABLE[sortKey as keyof typeof SORTABLE] ?? s.name

  const endpointCount = db().$count(schema.serverEndpoints, eq(schema.serverEndpoints.serverId, s.id))

  const [rows, [{ total }]] = await Promise.all([
    db().select({
      id: s.id, name: s.name, description: s.description, transport: s.transport, url: s.url, tlsVerify: s.tlsVerify,
      detectedVersion: s.detectedVersion, status: s.status, tags: s.tags,
      lastCheckedAt: s.lastCheckedAt, lastError: s.lastError, createdAt: s.createdAt, endpointCount,
    }).from(s).where(where)
      .orderBy(sortDir === 'desc' ? desc(sortCol) : asc(sortCol))
      .limit(q.pageSize).offset((q.page - 1) * q.pageSize),
    db().select({ total: count() }).from(s).where(where),
  ]) as [Array<Omit<ServerDto, 'lastCheckedAt' | 'createdAt'> & { lastCheckedAt: Date | null, createdAt: Date }>, [{ total: number }]]

  return {
    items: rows.map(r => ({ ...r, lastCheckedAt: r.lastCheckedAt?.toISOString() ?? null, createdAt: r.createdAt.toISOString() })),
    total,
    page: q.page,
    pageSize: q.pageSize,
  }
}
