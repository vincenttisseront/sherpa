import { requirePermission } from '../../../utils/auth'
import { idParam } from '../../../utils/validation'
import { getTargetOr404, targetScope } from '../../../services/projects'
import { rebuildPlan } from '../../../services/rebuild'

defineRouteMeta({ openAPI: { tags: ['targets'], summary: 'Reconstruction : version active et dernière version de la source (commit de la branche, release GitHub)' } })

export default defineEventHandler(async (event) => {
  const { id } = await getValidatedRouterParams(event, idParam.parse)
  const t = await getTargetOr404(id)
  await requirePermission(event, 'project:read', targetScope(t))
  return { ...await rebuildPlan(t), auto: t.target.autoRebuild ?? null }
})
