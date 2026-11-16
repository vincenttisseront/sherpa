import { requirePermission } from '../../../utils/auth'
import { idParam } from '../../../utils/validation'
import { getTargetOr404, lastActivationAt, publicVariables, targetScope, targetVariables } from '../../../services/projects'

defineRouteMeta({ openAPI: { tags: ['targets'], summary: 'Variables de la cible (valeurs secrètes jamais renvoyées)' } })

export default defineEventHandler(async (event) => {
  const { id } = await getValidatedRouterParams(event, idParam.parse)
  const t = await getTargetOr404(id)
  await requirePermission(event, 'project:read', targetScope(t))
  return publicVariables(await targetVariables(t.target), t.target.variablesMeta, await lastActivationAt(t.target))
})
