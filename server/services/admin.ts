/** Garde-fous d'administration des comptes et des droits. */
import { and, count, eq, inArray, isNull } from 'drizzle-orm'
import { createError } from 'h3'
import { db, schema } from '../db/client'

/** Utilisateurs actifs détenant le rôle admin en portée globale (directement ou via un groupe). */
type Executor = Pick<ReturnType<typeof db>, 'select'>

/** `exec` : passer la transaction en cours pour voir ses modifications non encore validées. */
export async function globalAdminUserIds(exec: Executor = db()): Promise<string[]> {
  const [admin] = await exec.select().from(schema.roles).where(eq(schema.roles.key, 'admin'))
  if (!admin) return []
  const bindings = await exec.select().from(schema.roleBindings).where(and(eq(schema.roleBindings.roleId, admin.id), isNull(schema.roleBindings.serverId), isNull(schema.roleBindings.environmentId), isNull(schema.roleBindings.projectId)))
  const direct = bindings.filter(b => b.subjectType === 'user').map(b => b.subjectId)
  const groupIds = bindings.filter(b => b.subjectType === 'group').map(b => b.subjectId)
  const viaGroups = groupIds.length ? (await exec.select({ id: schema.userGroups.userId }).from(schema.userGroups).where(inArray(schema.userGroups.groupId, groupIds))).map(r => r.id) : []
  const ids = [...new Set([...direct, ...viaGroups])]
  if (!ids.length) return []
  return (await exec.select({ id: schema.users.id }).from(schema.users).where(and(inArray(schema.users.id, ids), eq(schema.users.status, 'active')))).map(u => u.id)
}

/** Refuse une opération qui laisserait la plateforme sans administrateur actif. */
export async function assertAdminsRemain(simulate: () => Promise<string[]>, message = 'Opération refusée : la plateforme doit conserver au moins un administrateur actif') {
  const remaining = await simulate()
  if (remaining.length === 0) throw createError({ statusCode: 409, statusMessage: message })
}

export async function countUsers(): Promise<number> {
  const [{ n }] = await db().select({ n: count() }).from(schema.users) as [{ n: number }]
  return n
}
