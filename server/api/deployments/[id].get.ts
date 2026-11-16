import { requirePermission } from '../../utils/auth'
import { idParam } from '../../utils/validation'
import { type DeploymentDetailDto, deploymentScope, loadDeploymentDetail } from '../../services/deployments'

defineRouteMeta({ openAPI: { tags: ['deployments'], summary: 'Détail d\'un déploiement' } })

export default defineEventHandler(async (event): Promise<DeploymentDetailDto> => {
  const { id } = await getValidatedRouterParams(event, idParam.parse)
  await requirePermission(event, 'deployment:read', await deploymentScope(id))
  return loadDeploymentDetail(id)
})
