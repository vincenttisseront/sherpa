import { requirePermission } from '../../../utils/auth'
import { idParam } from '../../../utils/validation'
import { connectorDetail } from '../../../services/github-connectors'

defineRouteMeta({ openAPI: { tags: ['admin'], summary: 'Connecteur GitHub : dernier relevé (packages, artefacts, alertes)' } })

export default defineEventHandler(async (event) => {
  const { id } = await getValidatedRouterParams(event, idParam.parse)
  await requirePermission(event, 'policy:manage')
  return connectorDetail(id)
})
