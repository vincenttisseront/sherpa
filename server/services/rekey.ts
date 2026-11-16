/**
 * Rotation de la clé maîtresse (§19) : chiffre à nouveau, avec la clé courante,
 * tous les secrets encore chiffrés avec une ancienne clé. Idempotent ; chaque
 * secret est mis à jour seul et seulement s'il n'a pas changé entre-temps.
 */
import { and, eq, ne } from 'drizzle-orm'
import { db, schema } from '../db/client'
import { audit } from '../utils/audit'
import { getKeyring, reencrypt } from '../utils/crypto'

export interface RekeyReport {
  currentKeyId: string
  total: number
  toRotate: number
  rotated: number
  /** Secrets illisibles (clé absente du trousseau) : la rotation ne peut pas être terminée. */
  unreadable: { id: string, keyId: string, purpose: string }[]
  byKey: Record<string, number>
}

export async function rekeyAll(opts: { dryRun: boolean }): Promise<RekeyReport> {
  const ring = getKeyring()
  const rows = await db().select({ id: schema.secrets.id, keyId: schema.secrets.keyId, envelope: schema.secrets.envelope, purpose: schema.secrets.purpose }).from(schema.secrets)
  const report: RekeyReport = { currentKeyId: ring.currentId, total: rows.length, toRotate: 0, rotated: 0, unreadable: [], byKey: {} }
  for (const r of rows) {
    report.byKey[r.keyId] = (report.byKey[r.keyId] ?? 0) + 1
    if (r.keyId === ring.currentId) continue
    report.toRotate++
    if (!ring.keys.has(r.keyId)) {
      report.unreadable.push({ id: r.id, keyId: r.keyId, purpose: r.purpose })
      continue
    }
    if (opts.dryRun) continue
    const next = reencrypt(r.envelope, ring)
    if (!next) continue
    const done = await db().update(schema.secrets).set({ envelope: next.envelope, keyId: next.keyId })
      .where(and(eq(schema.secrets.id, r.id), eq(schema.secrets.envelope, r.envelope), ne(schema.secrets.keyId, ring.currentId)))
      .returning({ id: schema.secrets.id })
    report.rotated += done.length
  }
  if (!opts.dryRun) {
    await audit({ actorLabel: 'system', action: 'secrets.rekey', outcome: report.unreadable.length ? 'failure' : 'success', details: { currentKeyId: report.currentKeyId, rotated: report.rotated, unreadable: report.unreadable.length, before: report.byKey } })
  }
  return report
}
