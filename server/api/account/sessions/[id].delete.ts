import { and, eq } from 'drizzle-orm'
import { z } from 'zod'
import { db, schema } from '../../../db/client'
import { audit } from '../../../utils/audit'
import { clientIp, requireUser } from '../../../utils/auth'

defineRouteMeta({ openAPI: { tags: ['account'], summary: 'Révoque une de mes sessions' } })

export default defineEventHandler(async (event) => {
  const user = requireUser(event)
  const { id } = await getValidatedRouterParams(event, z.object({ id: z.string().regex(/^[a-f0-9]{64}$/) }).parse)
  const r = await db().update(schema.sessions).set({ revokedAt: new Date() }).where(and(eq(schema.sessions.id, id), eq(schema.sessions.userId, user.id ?? ''))).returning({ id: schema.sessions.id })
  if (!r.length) throw createError({ statusCode: 404, statusMessage: 'Session introuvable' })
  await audit({ actorUserId: user.id, actorLabel: user.email, action: 'account.session_revoke', outcome: 'success', ip: clientIp(event) })
  return { ok: true }
})
