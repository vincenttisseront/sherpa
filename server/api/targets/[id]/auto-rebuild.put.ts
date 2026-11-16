import { autoRebuildInput } from '../../../../shared/schemas/rebuild'
import { audit } from '../../../utils/audit'
import { clientIp, requirePermission } from '../../../utils/auth'
import { idParam, readValidated } from '../../../utils/validation'
import { getTargetOr404, targetScope } from '../../../services/projects'
import { setAutoRebuild } from '../../../services/rebuild'

defineRouteMeta({ openAPI: { tags: ['targets'], summary: 'Active ou coupe la reconstruction automatique de la cible à chaque nouvelle version de sa source' } })

export default defineEventHandler(async (event) => {
  const { id } = await getValidatedRouterParams(event, idParam.parse)
  const t = await getTargetOr404(id)
  const user = await requirePermission(event, 'deployment:execute', targetScope(t))
  const input = await readValidated(event, autoRebuildInput)
  const state = await setAutoRebuild(t, input)
  await audit({ actorUserId: user.id, actorLabel: user.email, action: 'target.auto_rebuild', targetType: 'project_target', targetId: id, ...targetScope(t), outcome: 'success', ip: clientIp(event), details: input })
  return state
})
