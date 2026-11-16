import { z } from 'zod'
import { requirePermission } from '../../../../utils/auth'
import { liveEndpoints } from '../../../../services/live'
import { deleteProxyRoute } from '../../../../services/proxy-routes'
import { getEndpointOr404 } from '../../../../services/servers'

defineRouteMeta({ openAPI: { tags: ['proxy'], summary: 'Retire une route du Traefik géré (conteneur détaché du réseau s\'il avait été rattaché par la plateforme)' } })

export default defineEventHandler(async (event) => {
  const { id, routeId } = await getValidatedRouterParams(event, z.object({ id: z.uuid(), routeId: z.uuid() }).parse)
  const ep = await getEndpointOr404(id)
  const user = await requirePermission(event, 'domain:manage', { serverId: ep.serverId })
  const [row] = await liveEndpoints(user, id)
  if (!row) throw createError({ statusCode: 404, statusMessage: 'Endpoint introuvable' })
  await deleteProxyRoute(row, routeId, user)
  setResponseStatus(event, 204)
  return null
})
