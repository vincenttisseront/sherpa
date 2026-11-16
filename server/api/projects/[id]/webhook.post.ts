import { audit } from '../../../utils/audit'
import { clientIp, requirePermission } from '../../../utils/auth'
import { idParam } from '../../../utils/validation'
import { rotateWebhookSecret, webhookUrl } from '../../../services/webhooks'

defineRouteMeta({ openAPI: { tags: ['webhooks'], summary: 'Génère ou remplace le secret du webhook GitHub du projet : renvoyé UNE fois' } })

export default defineEventHandler(async (event) => {
  const { id } = await getValidatedRouterParams(event, idParam.parse)
  const user = await requirePermission(event, 'project:update', { projectId: id })
  const { secret } = await rotateWebhookSecret(id)
  await audit({ actorUserId: user.id, actorLabel: user.email, action: 'project.webhook_secret', targetType: 'project', targetId: id, projectId: id, outcome: 'success', ip: clientIp(event), details: {} })
  return { url: webhookUrl(id), secret }
})
