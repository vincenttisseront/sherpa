import { proxyRoutesCreate } from '../../../../../shared/schemas/proxy-routes'
import { requirePermission } from '../../../../utils/auth'
import { idParam, readValidated } from '../../../../utils/validation'
import { liveEndpoints } from '../../../../services/live'
import { createProxyRoutes } from '../../../../services/proxy-routes'
import { getEndpointOr404 } from '../../../../services/servers'

defineRouteMeta({ openAPI: { tags: ['proxy'], summary: 'Passe des conteneurs hors plateforme derrière le Traefik géré (rattachement réseau + routes, effectives à l\'application du proxy)' } })

export default defineEventHandler(async (event) => {
  const { id } = await getValidatedRouterParams(event, idParam.parse)
  const ep = await getEndpointOr404(id)
  const user = await requirePermission(event, 'domain:manage', { serverId: ep.serverId })
  const { routes } = await readValidated(event, proxyRoutesCreate)
  const [row] = await liveEndpoints(user, id)
  if (!row) throw createError({ statusCode: 404, statusMessage: 'Endpoint introuvable' })
  setResponseStatus(event, 201)
  return createProxyRoutes(row, routes, user)
})
