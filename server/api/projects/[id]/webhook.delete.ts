import { audit } from '../../../utils/audit'
import { clientIp, requirePermission } from '../../../utils/auth'
import { idParam } from '../../../utils/validation'
import { deleteProjectWebhook } from '../../../services/webhooks'

defineRouteMeta({ openAPI: { tags: ['webhooks'], summary: 'Supprime le webhook GitHub du projet (les livraisons suivantes sont refusées)' } })

export default defineEventHandler(async (event) => {
  const { id } = await getValidatedRouterParams(event, idParam.parse)
  const user = await requirePermission(event, 'project:update', { projectId: id })
  await deleteProjectWebhook(id)
  await audit({ actorUserId: user.id, actorLabel: user.email, action: 'project.webhook_deleted', targetType: 'project', targetId: id, projectId: id, outcome: 'success', ip: clientIp(event), details: {} })
  return { deleted: true }
})
