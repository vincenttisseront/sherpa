import { and, desc, eq, gt, isNull } from 'drizzle-orm'
import { db, schema } from '../../../db/client'
import { requirePermission } from '../../../utils/auth'
import { idParam } from '../../../utils/validation'

defineRouteMeta({ openAPI: { tags: ['admin'], summary: 'Détail d\'un utilisateur : groupes, rôles attribués, sessions' } })

export default defineEventHandler(async (event) => {
  await requirePermission(event, 'user:manage')
  const { id } = await getValidatedRouterParams(event, idParam.parse)
  const [r] = await db().select({ u: schema.users, idp: schema.identityProviders.name }).from(schema.users).leftJoin(schema.identityProviders, eq(schema.identityProviders.id, schema.users.idpId)).where(eq(schema.users.id, id))
  if (!r) throw createError({ statusCode: 404, statusMessage: 'Utilisateur introuvable' })
  const groups = await db().select({ id: schema.groups.id, name: schema.groups.name, fromIdp: schema.userGroups.fromIdp }).from(schema.userGroups).innerJoin(schema.groups, eq(schema.groups.id, schema.userGroups.groupId)).where(eq(schema.userGroups.userId, id))
  const sessions = await db().select().from(schema.sessions).where(and(eq(schema.sessions.userId, id), isNull(schema.sessions.revokedAt), gt(schema.sessions.expiresAt, new Date()))).orderBy(desc(schema.sessions.lastSeenAt))
  const u = r.u
  return {
    id: u.id, email: u.email, displayName: u.displayName, kind: u.kind, status: u.status, idp: r.idp,
    locked: !!u.lockedUntil && u.lockedUntil.getTime() > Date.now(), lockedUntil: u.lockedUntil?.toISOString() ?? null,
    expiresAt: u.expiresAt?.toISOString() ?? null, lastLoginAt: u.lastLoginAt?.toISOString() ?? null, passwordChangedAt: u.passwordChangedAt?.toISOString() ?? null,
    createdAt: u.createdAt.toISOString(), groups,
    sessions: sessions.map(s => ({ ip: s.ip, userAgent: s.userAgent, sso: !!s.idpId, createdAt: s.createdAt.toISOString(), lastSeenAt: s.lastSeenAt.toISOString() })),
  }
})
