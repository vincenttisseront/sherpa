import { requirePermission } from '../../../utils/auth'
import { idParam } from '../../../utils/validation'
import { upgradedCompose } from '../../../services/image-upgrade'
import { getTargetOr404, targetScope } from '../../../services/projects'

defineRouteMeta({ openAPI: { tags: ['targets'], summary: 'Compose source avec les images mises à niveau, à reporter dans le dépôt ou l\'archive' } })

export default defineEventHandler(async (event) => {
  const { id } = await getValidatedRouterParams(event, idParam.parse)
  const t = await getTargetOr404(id)
  await requirePermission(event, 'project:read', targetScope(t))
  return upgradedCompose(t)
})
