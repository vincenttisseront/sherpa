import { audit } from '../../../../../utils/audit'
import { clientIp, requirePermission } from '../../../../../utils/auth'
import { idParam } from '../../../../../utils/validation'
import { digestNow } from '../../../../../services/notifications'

defineRouteMeta({ openAPI: { tags: ['notifications'], summary: 'Envoie aussitôt le résumé d\'un canal en mode résumé (évènements depuis le dernier résumé)' } })

export default defineEventHandler(async (event) => {
  const user = await requirePermission(event, 'notification:manage')
  const { id } = await getValidatedRouterParams(event, idParam.parse)
  try {
    const r = await digestNow(id)
    await audit({ actorUserId: user.id, actorLabel: user.email, action: 'notification.digest_now', targetType: 'notification_channel', targetId: id, outcome: 'success', ip: clientIp(event), details: r })
    return r
  }
  catch (err) {
    throw createError({ statusCode: 409, statusMessage: (err as Error).message })
  }
})
