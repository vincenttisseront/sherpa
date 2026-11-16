import { requirePermission } from '../../../../utils/auth'
import { idParam } from '../../../../utils/validation'
import { getTargetOr404, targetScope } from '../../../../services/projects'
import { autoRebuildTarget } from '../../../../services/rebuild'

defineRouteMeta({ openAPI: { tags: ['targets'], summary: 'Reconstruction automatique : vérifie maintenant si une nouvelle version est disponible (et la reconstruit)' } })

export default defineEventHandler(async (event) => {
  const { id } = await getValidatedRouterParams(event, idParam.parse)
  const t = await getTargetOr404(id)
  await requirePermission(event, 'deployment:execute', targetScope(t))
  const outcome = await autoRebuildTarget(t)
  const fresh = await getTargetOr404(id)
  return { outcome, state: fresh.target.autoRebuild }
})
