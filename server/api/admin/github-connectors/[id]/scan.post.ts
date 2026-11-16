import { requirePermission } from '../../../../utils/auth'
import { idParam } from '../../../../utils/validation'
import { connectorDetail, scanGithubConnector } from '../../../../services/github-connectors'

defineRouteMeta({ openAPI: { tags: ['admin'], summary: 'Relève maintenant les packages et artefacts du connecteur GitHub' } })

export default defineEventHandler(async (event) => {
  const { id } = await getValidatedRouterParams(event, idParam.parse)
  await requirePermission(event, 'policy:manage')
  await scanGithubConnector(id)
  return connectorDetail(id)
})
