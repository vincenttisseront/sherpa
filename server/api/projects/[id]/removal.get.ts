import type { ProjectRemovalPlan } from '../../../../shared/schemas/project-removal'
import { requirePermission } from '../../../utils/auth'
import { idParam } from '../../../utils/validation'
import { removalPlan } from '../../../services/project-removal'

defineRouteMeta({ openAPI: { tags: ['projects'], summary: 'Fin de vie du projet : stacks, Compose en service et données par cible (suppression ou détachement)' } })

export default defineEventHandler(async (event): Promise<ProjectRemovalPlan> => {
  const { id } = await getValidatedRouterParams(event, idParam.parse)
  await requirePermission(event, 'project:read', { projectId: id })
  return removalPlan(id)
})
