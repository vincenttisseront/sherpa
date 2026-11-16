import { requirePermission } from '../../../../utils/auth'
import { idParam } from '../../../../utils/validation'
import { liveEndpoints } from '../../../../services/live'
import { ensureProxyRouteNetworks } from '../../../../services/proxy-routes'
import { getEndpointOr404 } from '../../../../services/servers'

defineRouteMeta({ openAPI: { tags: ['proxy'], summary: 'Rattache maintenant au réseau du proxy les conteneurs routés qui l\'ont perdu (recréation)' } })

export default defineEventHandler(async (event) => {
  const { id } = await getValidatedRouterParams(event, idParam.parse)
  const ep = await getEndpointOr404(id)
  const user = await requirePermission(event, 'domain:manage', { serverId: ep.serverId })
  const [row] = await liveEndpoints(user, id)
  if (!row) throw createError({ statusCode: 404, statusMessage: 'Endpoint introuvable' })
  return { reattached: await ensureProxyRouteNetworks(row) }
})
