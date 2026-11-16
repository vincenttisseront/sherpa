import { eq } from 'drizzle-orm'
import { resetMfa } from '../../../../auth/mfa'
import { revokeUserSessions } from '../../../../auth/sessions'
import { db, schema } from '../../../../db/client'
import { audit } from '../../../../utils/audit'
import { clientIp, requirePermission } from '../../../../utils/auth'
import { idParam } from '../../../../utils/validation'

defineRouteMeta({ openAPI: { tags: ['admin'], summary: 'Retire tous les seconds facteurs d\'un compte (appareil perdu) et révoque ses sessions' } })

export default defineEventHandler(async (event) => {
  const actor = await requirePermission(event, 'user:manage')
  const { id } = await getValidatedRouterParams(event, idParam.parse)
  const [u] = await db().select().from(schema.users).where(eq(schema.users.id, id))
  if (!u) throw createError({ statusCode: 404, statusMessage: 'Utilisateur introuvable' })
  await resetMfa(id)
  const revoked = await revokeUserSessions(id)
  await audit({ actorUserId: actor.id, actorLabel: actor.email, action: 'user.mfa_reset', targetType: 'user', targetId: id, outcome: 'success', ip: clientIp(event), details: { email: u.email, revokedSessions: revoked } })
  return { ok: true, revokedSessions: revoked }
})
