import { revokeUserSessions } from '../../../../auth/sessions'
import { audit } from '../../../../utils/audit'
import { clientIp, requirePermission } from '../../../../utils/auth'
import { idParam } from '../../../../utils/validation'

defineRouteMeta({ openAPI: { tags: ['admin'], summary: 'Révoque toutes les sessions d\'un utilisateur' } })

export default defineEventHandler(async (event) => {
  const actor = await requirePermission(event, 'user:manage')
  const { id } = await getValidatedRouterParams(event, idParam.parse)
  const n = await revokeUserSessions(id)
  await audit({ actorUserId: actor.id, actorLabel: actor.email, action: 'user.sessions_revoke', targetType: 'user', targetId: id, outcome: 'success', ip: clientIp(event), details: { revoked: n } })
  return { revoked: n }
})
