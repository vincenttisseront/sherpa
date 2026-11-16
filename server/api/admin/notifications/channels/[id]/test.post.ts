import { audit } from '../../../../../utils/audit'
import { clientIp, requirePermission } from '../../../../../utils/auth'
import { idParam } from '../../../../../utils/validation'
import { testChannel } from '../../../../../services/notifications'

defineRouteMeta({ openAPI: { tags: ['notifications'], summary: 'Envoie un message de test sur le canal' } })

export default defineEventHandler(async (event) => {
  const user = await requirePermission(event, 'notification:manage')
  const { id } = await getValidatedRouterParams(event, idParam.parse)
  try {
    await testChannel(id, user.email)
    await audit({ actorUserId: user.id, actorLabel: user.email, action: 'notification.test', targetType: 'notification_channel', targetId: id, outcome: 'success', ip: clientIp(event) })
    return { ok: true }
  }
  catch (err) {
    await audit({ actorUserId: user.id, actorLabel: user.email, action: 'notification.test', targetType: 'notification_channel', targetId: id, outcome: 'failure', ip: clientIp(event), details: { error: (err as Error).message } })
    throw createError({ statusCode: 502, statusMessage: `Envoi de test en échec : ${(err as Error).message}` })
  }
})
