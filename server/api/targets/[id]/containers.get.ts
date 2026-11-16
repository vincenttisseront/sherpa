import type { TargetContainers } from '../../../../shared/schemas/diagnostic'
import { requirePermission } from '../../../utils/auth'
import { idParam } from '../../../utils/validation'
import { targetContainers } from '../../../services/diagnostic'
import { getTargetOr404, targetScope } from '../../../services/projects'

defineRouteMeta({ openAPI: { tags: ['targets'], summary: 'Conteneurs de la stack de la cible : état, ports, fraîcheur de l\'image, services sans conteneur' } })

export default defineEventHandler(async (event): Promise<TargetContainers> => {
  const { id } = await getValidatedRouterParams(event, idParam.parse)
  const t = await getTargetOr404(id)
  await requirePermission(event, 'project:read', targetScope(t))
  return targetContainers(t)
})
