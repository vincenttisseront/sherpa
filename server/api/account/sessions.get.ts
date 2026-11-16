import { and, desc, eq, gt, isNull } from 'drizzle-orm'
import { db, schema } from '../../db/client'
import { requireUser } from '../../utils/auth'

defineRouteMeta({ openAPI: { tags: ['account'], summary: 'Mes sessions actives' } })

export default defineEventHandler(async (event) => {
  const user = requireUser(event)
  if (!user.id) return []
  const rows = await db().select().from(schema.sessions).where(and(eq(schema.sessions.userId, user.id), isNull(schema.sessions.revokedAt), gt(schema.sessions.expiresAt, new Date()))).orderBy(desc(schema.sessions.lastSeenAt))
  return rows.map(s => ({ id: s.id, current: s.id === event.context.session?.id, ip: s.ip, userAgent: s.userAgent, sso: !!s.idpId, createdAt: s.createdAt.toISOString(), lastSeenAt: s.lastSeenAt.toISOString(), expiresAt: s.expiresAt.toISOString() }))
})
