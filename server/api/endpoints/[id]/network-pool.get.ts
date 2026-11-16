import type { NetworkPoolDto } from '../../../../shared/schemas/network-pool'
import { requirePermission } from '../../../utils/auth'
import { idParam } from '../../../utils/validation'
import { getNetworkPool } from '../../../services/network-pool'
import { getEndpointOr404 } from '../../../services/servers'

defineRouteMeta({ openAPI: { tags: ['endpoints'], summary: 'Plage d\'adresses des réseaux des projets, sous-réseaux attribués et sous-réseaux déjà pris sur l\'hôte' } })

export default defineEventHandler(async (event): Promise<NetworkPoolDto> => {
  const { id } = await getValidatedRouterParams(event, idParam.parse)
  const ep = await getEndpointOr404(id)
  await requirePermission(event, 'server:read', { serverId: ep.serverId })
  return getNetworkPool(id)
})
