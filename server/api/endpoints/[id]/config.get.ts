import { requirePermission } from '../../../utils/auth'
import { idParam } from '../../../utils/validation'
import { type EndpointConfigDto, loadEndpointConfig } from '../../../services/endpoint-config'
import { getEndpointOr404 } from '../../../services/servers'

defineRouteMeta({ openAPI: { tags: ['endpoints'], summary: 'Chemins par environnement, règles de ports et Traefik' } })

export default defineEventHandler(async (event): Promise<EndpointConfigDto> => {
  const { id } = await getValidatedRouterParams(event, idParam.parse)
  const ep = await getEndpointOr404(id)
  await requirePermission(event, 'server:read', { serverId: ep.serverId })
  return loadEndpointConfig(id)
})
