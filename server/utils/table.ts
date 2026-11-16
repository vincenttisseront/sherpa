/**
 * Tableaux (§17) côté serveur : période relative ou absolue, export CSV
 * des mêmes données que l'écran (mêmes filtres, mêmes droits).
 */
import { type H3Event, getValidatedQuery, setHeader } from 'h3'
import { z } from 'zod'
import { PERIOD_MS, type Paginated, type TableQuery } from '../../shared/schemas/common'
import { audit } from './audit'
import { type AuthUser, clientIp } from './auth'

export function periodRange(q: Pick<TableQuery, 'period' | 'from' | 'to'>): { from?: Date, to?: Date } {
  const from = q.period ? new Date(Date.now() - PERIOD_MS[q.period]) : q.from ? new Date(q.from) : undefined
  return { from, to: !q.period && q.to ? new Date(q.to) : undefined }
}

export interface CsvColumn<T> {
  key: string
  label: string
  value: (row: T) => unknown
}

const exportQuery = z.object({
  format: z.enum(['json', 'csv']).default('json'),
  columns: z.string().max(2000).optional(),
})

const MAX_EXPORT_ROWS = 50_000
const PAGE = 1000

const fmt = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/Paris', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' })
const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/

/** Valeur d'une cellule : dates lisibles (heure de Paris), protection contre l'injection de formules. */
export function csvCell(v: unknown): string {
  if (v === null || v === undefined) return ''
  let s: string
  if (v instanceof Date) s = fmt.format(v)
  else if (Array.isArray(v)) s = v.join(', ')
  else if (typeof v === 'object') s = JSON.stringify(v)
  else s = String(v)
  if (typeof v === 'string' && ISO_RE.test(v)) s = fmt.format(new Date(v))
  // Un tableur exécuterait =, +, -, @ en tête de cellule (OWASP CSV injection).
  if (typeof v === 'string' && /^[=+\-@\t\r]/.test(s)) s = `'${s}`
  return /[";\n\r]/.test(s) ? `"${s.replaceAll('"', '""')}"` : s
}

export function toCsv<T>(rows: T[], columns: CsvColumn<T>[]): string {
  // BOM + « ; » : ouverture directe dans Excel en français.
  return `\uFEFF${[columns.map(c => csvCell(c.label)).join(';'), ...rows.map(r => columns.map(c => csvCell(c.value(r))).join(';'))].join('\r\n')}\r\n`
}

/**
 * Réponse d'un tableau : JSON paginé, ou CSV de toutes les lignes filtrées
 * (colonnes visibles choisies par l'utilisateur). Chaque export est audité.
 */
export async function tableResponse<T, Q extends TableQuery>(
  event: H3Event,
  q: Q,
  load: (q: Q) => Promise<Paginated<T>>,
  opts: { name: string, columns: CsvColumn<T>[], user: AuthUser },
): Promise<Paginated<T> | string> {
  const { format, columns } = await getValidatedQuery(event, exportQuery.parse)
  if (format === 'json') return load(q)

  const wanted = columns?.split(',').filter(Boolean)
  const cols = wanted?.length ? opts.columns.filter(c => wanted.includes(c.key)) : opts.columns
  const rows: T[] = []
  for (let page = 1; rows.length < MAX_EXPORT_ROWS; page++) {
    const r = await load({ ...q, page, pageSize: PAGE })
    rows.push(...r.items)
    if (r.items.length < PAGE || rows.length >= r.total) break
  }
  const stamp = new Date().toISOString().slice(0, 16).replace(/[-:T]/g, '')
  setHeader(event, 'content-type', 'text/csv; charset=utf-8')
  setHeader(event, 'content-disposition', `attachment; filename="${opts.name}-${stamp}.csv"`)
  setHeader(event, 'cache-control', 'no-store')
  await audit({
    actorUserId: opts.user.id, actorLabel: opts.user.email, action: 'export.csv', targetType: 'table', targetId: opts.name, outcome: 'success', ip: clientIp(event),
    details: { rows: Math.min(rows.length, MAX_EXPORT_ROWS), columns: cols.map(c => c.key), filters: Object.fromEntries(Object.entries(q).filter(([k, v]) => v !== undefined && k !== 'page' && k !== 'pageSize')) },
  })
  return toCsv(rows.slice(0, MAX_EXPORT_ROWS), cols)
}
