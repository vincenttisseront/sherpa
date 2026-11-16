import { targetWebhookInput } from '../../../../shared/schemas/webhook'
import { audit } from '../../../utils/audit'
import { clientIp, requirePermission } from '../../../utils/auth'
import { idParam, readValidated } from '../../../utils/validation'
import { getTargetOr404, targetScope } from '../../../services/projects'
import { setTargetWebhook } from '../../../services/webhooks'

defineRouteMeta({ openAPI: { tags: ['webhooks'], summary: 'Déploiement au push GitHub pour cet environnement : activation, branche suivie' } })

export default defineEventHandler(async (event) => {
  const { id } = await getValidatedRouterParams(event, idParam.parse)
  const t = await getTargetOr404(id)
  const user = await requirePermission(event, 'deployment:execute', targetScope(t))
  const input = await readValidated(event, targetWebhookInput)
  const state = await setTargetWebhook(t, input)
  await audit({ actorUserId: user.id, actorLabel: user.email, action: 'target.webhook', targetType: 'project_target', targetId: id, ...targetScope(t), outcome: 'success', ip: clientIp(event), details: input })
  return state
})
