import { requirePermission } from '../../../utils/auth'
import { idParam } from '../../../utils/validation'
import { getProjectWebhook } from '../../../services/webhooks'

defineRouteMeta({ openAPI: { tags: ['webhooks'], summary: 'Webhook GitHub du projet : adresse, environnements concernés, dernières livraisons (le secret n\'est jamais renvoyé)' } })

export default defineEventHandler(async (event) => {
  const { id } = await getValidatedRouterParams(event, idParam.parse)
  await requirePermission(event, 'project:update', { projectId: id })
  return getProjectWebhook(id)
})
