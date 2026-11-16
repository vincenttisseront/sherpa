/**
 * Rétention (§14) : logs, audit, évènements de notification et historique des
 * images au-delà de RETENTION_DAYS (six mois par défaut). Suppression par lots
 * pour ne jamais verrouiller longtemps une table volumineuse.
 */
import { desc, eq, sql } from 'drizzle-orm'
import { db, schema } from '../db/client'
import { audit } from '../utils/audit'

/** Tables purgées : nom SQL, colonne de date, libellé. Liste figée (aucune entrée utilisateur dans le SQL). */
export const RETAINED = [
  { key: 'logs', table: 'deployment_logs', column: 'ts', label: 'Logs de déploiement' },
  { key: 'audit', table: 'audit_events', column: 'ts', label: 'Journal d\'audit' },
  { key: 'notifications', table: 'notification_events', column: 'created_at', label: 'Notifications et envois' },
  { key: 'imageUpdates', table: 'image_updates', column: 'detected_at', label: 'Historique des images' },
] as const
type Key = (typeof RETAINED)[number]['key']

const BATCH = 10_000

async function purgeTable(table: string, column: string, retentionDays: number): Promise<number> {
  let total = 0
  for (;;) {
    const r = await db().execute(sql`delete from ${sql.identifier(table)} where id in (select id from ${sql.identifier(table)} where ${sql.identifier(column)} < now() - make_interval(days => ${retentionDays}) limit ${BATCH})`)
    const n = (r as unknown as { count: number }).count ?? 0
    total += n
    if (n < BATCH) return total
  }
}

const SYSTEM_ACTOR: { id?: string | null, label: string } = { label: 'system' }

export async function purgeExpired(retentionDays: number, actor: { id?: string | null, label: string } = SYSTEM_ACTOR): Promise<Record<Key, number>> {
  const out = {} as Record<Key, number>
  for (const t of RETAINED) out[t.key] = await purgeTable(t.table, t.column, retentionDays)
  await audit({ actorUserId: actor.id ?? null, actorLabel: actor.label, action: 'retention.purge', outcome: 'success', details: { retentionDays, ...out } })
  return out
}

export interface RetentionStatus {
  retentionDays: number
  tables: { key: Key, label: string, rows: number, expired: number, oldest: string | null }[]
  lastPurge: { at: string, by: string, details: Record<string, unknown> } | null
}

export async function retentionStatus(retentionDays: number): Promise<RetentionStatus> {
  const tables: RetentionStatus['tables'] = []
  for (const t of RETAINED) {
    const [r] = await db().execute(sql`select count(*)::int as rows,
      count(*) filter (where ${sql.identifier(t.column)} < now() - make_interval(days => ${retentionDays}))::int as expired,
      min(${sql.identifier(t.column)}) as oldest from ${sql.identifier(t.table)}`) as unknown as { rows: number, expired: number, oldest: Date | string | null }[]
    tables.push({ key: t.key, label: t.label, rows: r!.rows, expired: r!.expired, oldest: r!.oldest ? new Date(r!.oldest).toISOString() : null })
  }
  const [last] = await db().select().from(schema.auditEvents).where(eq(schema.auditEvents.action, 'retention.purge')).orderBy(desc(schema.auditEvents.ts)).limit(1)
  return { retentionDays, tables, lastPurge: last ? { at: last.ts.toISOString(), by: last.actorLabel, details: last.details as Record<string, unknown> } : null }
}
