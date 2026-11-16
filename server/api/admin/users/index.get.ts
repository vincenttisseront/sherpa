import { and, asc, count, desc, eq, gte, ilike, inArray, lte, or, sql, type SQL } from 'drizzle-orm'
import type { z } from 'zod'
import type { AdminUserRow } from '../../../../shared/schemas/admin'
import { userListQuery } from '../../../../shared/schemas/admin'
import type { Paginated } from '../../../../shared/schemas/common'
import { db, schema } from '../../../db/client'
import { requirePermission } from '../../../utils/auth'
import { type CsvColumn, periodRange, tableResponse } from '../../../utils/table'

defineRouteMeta({ openAPI: { tags: ['admin'], summary: 'Utilisateurs (recherche, filtres statut/type, pagination)' } })

const CSV: CsvColumn<AdminUserRow>[] = [
  { key: 'email', label: 'Email', value: r => r.email },
  { key: 'displayName', label: 'Nom', value: r => r.displayName },
  { key: 'kind', label: 'Type', value: r => r.kind },
  { key: 'status', label: 'Statut', value: r => (r.locked ? 'verrouillé' : r.status) },
  { key: 'idp', label: 'Fournisseur', value: r => r.idp },
  { key: 'groups', label: 'Groupes', value: r => r.groups },
  { key: 'lastLoginAt', label: 'Dernière connexion', value: r => r.lastLoginAt },
  { key: 'expiresAt', label: 'Expire le', value: r => r.expiresAt },
  { key: 'createdAt', label: 'Créé le', value: r => r.createdAt },
]

export default defineEventHandler(async (event) => {
  const user = await requirePermission(event, 'user:manage')
  const q = await getValidatedQuery(event, userListQuery.parse)
  return tableResponse(event, q, listUsers, { name: 'utilisateurs', columns: CSV, user })
})

async function listUsers(q: z.infer<typeof userListQuery>): Promise<Paginated<AdminUserRow>> {
  const u = schema.users
  const where: SQL[] = []
  if (q.q) where.push(or(ilike(u.email, `%${q.q}%`), ilike(u.displayName, `%${q.q}%`))!)
  if (q.kind) where.push(eq(u.kind, q.kind))
  const { from, to } = periodRange(q)
  if (from) where.push(gte(u.createdAt, from))
  if (to) where.push(lte(u.createdAt, to))
  if (q.status === 'locked') where.push(sql`${u.lockedUntil} > now()`)
  else if (q.status === 'expired') where.push(sql`${u.expiresAt} <= now()`)
  else if (q.status) where.push(eq(u.status, q.status))
  const w = where.length ? and(...where) : undefined
  const [key, dir] = (q.sort ?? 'email:asc').split(':') as [string, 'asc' | 'desc']
  const col = key === 'lastLoginAt' ? u.lastLoginAt : key === 'createdAt' ? u.createdAt : key === 'displayName' ? u.displayName : u.email
  const rows = await db().select({ u, idp: schema.identityProviders.name }).from(u).leftJoin(schema.identityProviders, eq(schema.identityProviders.id, u.idpId))
    .where(w).orderBy(dir === 'desc' ? desc(col) : asc(col)).limit(q.pageSize).offset((q.page - 1) * q.pageSize)
  const [{ total }] = await db().select({ total: count() }).from(u).where(w) as [{ total: number }]
  const ids = rows.map(r => r.u.id)
  const memberships = ids.length ? await db().select({ userId: schema.userGroups.userId, name: schema.groups.name }).from(schema.userGroups).innerJoin(schema.groups, eq(schema.groups.id, schema.userGroups.groupId)).where(inArray(schema.userGroups.userId, ids)) : []
  return {
    items: rows.map(({ u: x, idp }) => ({
      id: x.id, email: x.email, displayName: x.displayName, kind: x.kind, status: x.status,
      locked: !!x.lockedUntil && x.lockedUntil.getTime() > Date.now(),
      expiresAt: x.expiresAt?.toISOString() ?? null, lastLoginAt: x.lastLoginAt?.toISOString() ?? null,
      idp, groups: memberships.filter(m => m.userId === x.id).map(m => m.name), createdAt: x.createdAt.toISOString(),
    })),
    total, page: q.page, pageSize: q.pageSize,
  }
}
