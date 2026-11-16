import type { ProxyRouteDto } from '../../../../../shared/schemas/proxy-routes'
import { requireAnyPermission } from '../../../../utils/auth'
import { idParam } from '../../../../utils/validation'
import { liveEndpoints } from '../../../../services/live'
import { listProxyRoutes } from '../../../../services/proxy-routes'

defineRouteMeta({ openAPI: { tags: ['proxy'], summary: 'Routes du Traefik géré vers des conteneurs hors plateforme (état du rattachement et de l\'application)' } })

export default defineEventHandler(async (event): Promise<ProxyRouteDto[]> => {
  const { id } = await getValidatedRouterParams(event, idParam.parse)
  const user = await requireAnyPermission(event, 'server:read')
  const [row] = await liveEndpoints(user, id)
  if (!row) throw createError({ statusCode: 404, statusMessage: 'Endpoint introuvable' })
  return listProxyRoutes(row)
})
