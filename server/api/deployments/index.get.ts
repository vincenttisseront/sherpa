import { deploymentListQuery } from '../../../shared/schemas/lists'
import { requireAnyPermission } from '../../utils/auth'
import { tableResponse } from '../../utils/table'
import { visibleTargetIds } from '../../services/access'
import { DEPLOYMENT_CSV, listDeployments } from '../../services/lists'

defineRouteMeta({ openAPI: { tags: ['deployments'], summary: 'Déploiements et actions de toutes les cibles visibles (filtres combinables, export CSV)' } })

export default defineEventHandler(async (event) => {
  const user = await requireAnyPermission(event, 'deployment:read')
  const visible = await visibleTargetIds(user, 'deployment:read')
  const q = await getValidatedQuery(event, deploymentListQuery.parse)
  return tableResponse(event, q, x => listDeployments(x, visible), { name: 'deploiements', columns: DEPLOYMENT_CSV, user })
})
