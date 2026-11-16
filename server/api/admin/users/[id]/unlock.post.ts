import { eq } from 'drizzle-orm'
import { db, schema } from '../../../../db/client'
import { audit } from '../../../../utils/audit'
import { clientIp, requirePermission } from '../../../../utils/auth'
import { idParam } from '../../../../utils/validation'

defineRouteMeta({ openAPI: { tags: ['admin'], summary: 'Lève le verrouillage après échecs de connexion' } })

export default defineEventHandler(async (event) => {
  const actor = await requirePermission(event, 'user:manage')
  const { id } = await getValidatedRouterParams(event, idParam.parse)
  await db().update(schema.users).set({ lockedUntil: null, failedLoginCount: 0 }).where(eq(schema.users.id, id))
  await audit({ actorUserId: actor.id, actorLabel: actor.email, action: 'user.unlock', targetType: 'user', targetId: id, outcome: 'success', ip: clientIp(event) })
  return { ok: true }
})
