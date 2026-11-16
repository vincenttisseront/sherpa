/**
 * Logs de déploiement (§14) : PostgreSQL est la source de vérité, Redis
 * diffuse les nouvelles lignes en temps réel (pub/sub) pour le flux SSE.
 * Toute ligne est masquée avant d'être écrite ou publiée.
 */
import { and, asc, desc, eq, gt, ilike, inArray, lt, type SQL } from 'drizzle-orm'
import { db, schema } from '../db/client'
import { redis } from '../queue/redis'
import type { Redactor } from '../utils/redact'
import { redactPatterns } from '../utils/redact'

export type LogLevel = (typeof schema.logLevel.enumValues)[number]
export type LogPhase = (typeof schema.logPhase.enumValues)[number]

export interface LogLine {
  id: string
  ts: string
  phase: LogPhase
  level: LogLevel
  service: string | null
  message: string
}

/** Une ligne de log ne dépasse pas cette taille (protection de la base et de l'UI). */
const MAX_MESSAGE = 8_000

export const logChannel = (deploymentId: string) => `logs:deployment:${deploymentId}`

export async function appendLogs(deploymentId: string, entries: { phase: LogPhase, level?: LogLevel, service?: string | null, message: string }[], redactor?: Redactor): Promise<LogLine[]> {
  if (!entries.length) return []
  const clean = (m: string) => {
    const r = redactor ? redactor.redact(m) : redactPatterns(m)
    return r.length > MAX_MESSAGE ? `${r.slice(0, MAX_MESSAGE)}… [tronqué]` : r
  }
  const rows = await db().insert(schema.deploymentLogs).values(entries.map(e => ({
    deploymentId,
    phase: e.phase,
    level: e.level ?? 'info',
    service: e.service ?? null,
    message: clean(e.message),
  }))).returning()
  const lines = rows.map(toLine)
  // La diffusion est best effort : la base reste la référence (le client recharge depuis le dernier id).
  await redis().publish(logChannel(deploymentId), JSON.stringify(lines)).catch(() => {})
  return lines
}

export function toLine(r: typeof schema.deploymentLogs.$inferSelect): LogLine {
  return { id: String(r.id), ts: r.ts.toISOString(), phase: r.phase, level: r.level, service: r.service, message: r.message }
}

export interface LogQuery {
  afterId?: string
  beforeId?: string
  limit: number
  levels?: LogLevel[]
  phases?: LogPhase[]
  service?: string
  q?: string
  from?: string
  to?: string
}

/** Pagination par curseur (id), filtres combinables (§14). */
export async function queryLogs(deploymentId: string, q: LogQuery): Promise<{ lines: LogLine[], hasMore: boolean }> {
  const t = schema.deploymentLogs
  const where: SQL[] = [eq(t.deploymentId, deploymentId)]
  if (q.afterId) where.push(gt(t.id, BigInt(q.afterId)))
  if (q.beforeId) where.push(lt(t.id, BigInt(q.beforeId)))
  if (q.levels?.length) where.push(inArray(t.level, q.levels))
  if (q.phases?.length) where.push(inArray(t.phase, q.phases))
  if (q.service) where.push(eq(t.service, q.service))
  if (q.q) where.push(ilike(t.message, `%${q.q.replace(/[%_\\]/g, m => `\\${m}`)}%`))
  if (q.from) where.push(gt(t.ts, new Date(q.from)))
  if (q.to) where.push(lt(t.ts, new Date(q.to)))
  // Sans curseur « après », on renvoie la fin du journal (les lignes les plus récentes).
  const newestFirst = !q.afterId
  const rows = await db().select().from(t).where(and(...where))
    .orderBy(newestFirst ? desc(t.id) : asc(t.id)).limit(q.limit + 1)
  const hasMore = rows.length > q.limit
  const page = rows.slice(0, q.limit)
  if (newestFirst) page.reverse()
  return { lines: page.map(toLine), hasMore }
}
