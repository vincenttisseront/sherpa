import { z } from 'zod'
import { requirePermission } from '../../../utils/auth'
import { idParam } from '../../../utils/validation'
import { listTargetDeployments } from '../../../services/project-views'
import { getTargetOr404, targetScope } from '../../../services/projects'

defineRouteMeta({ openAPI: { tags: ['targets'], summary: 'Historique des déploiements de la cible' } })

export default defineEventHandler(async (event) => {
  const { id } = await getValidatedRouterParams(event, idParam.parse)
  const t = await getTargetOr404(id)
  await requirePermission(event, 'deployment:read', targetScope(t))
  const q = await getValidatedQuery(event, z.object({ page: z.coerce.number().int().min(1).default(1), pageSize: z.coerce.number().int().min(1).max(100).default(20) }).parse)
  return listTargetDeployments(id, q.page, q.pageSize)
})
