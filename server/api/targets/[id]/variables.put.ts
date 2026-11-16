import { variablesInput } from '../../../../shared/schemas/projects'
import { audit } from '../../../utils/audit'
import { clientIp, requirePermission } from '../../../utils/auth'
import { idParam, readValidated } from '../../../utils/validation'
import { getTargetOr404, lastActivationAt, publicVariables, setTargetVariables, targetScope, targetVariables } from '../../../services/projects'

defineRouteMeta({ openAPI: { tags: ['targets'], summary: 'Remplace les variables (secrète sans valeur = inchangée)' } })

export default defineEventHandler(async (event) => {
  const { id } = await getValidatedRouterParams(event, idParam.parse)
  const t = await getTargetOr404(id)
  const user = await requirePermission(event, 'project:update', targetScope(t))
  const input = await readValidated(event, variablesInput)
  await setTargetVariables(id, input)
  await audit({ actorUserId: user.id, actorLabel: user.email, action: 'target.variables', targetType: 'project_target', targetId: id, ...targetScope(t), outcome: 'success', ip: clientIp(event), details: { names: input.map(v => v.name), secrets: input.filter(v => v.secret).map(v => v.name) } })
  const fresh = await getTargetOr404(id)
  return publicVariables(await targetVariables(fresh.target), fresh.target.variablesMeta, await lastActivationAt(fresh.target))
})
