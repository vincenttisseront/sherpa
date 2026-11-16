import { z } from 'zod'
import { requestProgress } from '../../../../utils/progress'
import { idParam } from '../../../../utils/validation'
import { requireAnyPermission } from '../../../../utils/auth'
import { liveEndpoints } from '../../../../services/live'
import { endpointTopology } from '../../../../services/proxy'

defineRouteMeta({ openAPI: { tags: ['proxy'], summary: 'Reverse proxies de l\'endpoint : configuration Traefik effective, routes, TLS, réseaux (lecture seule)' } })

const query = z.object({ refresh: z.enum(['0', '1']).optional() })

export default defineEventHandler(async (event) => {
  const { id } = await getValidatedRouterParams(event, idParam.parse)
  const { refresh } = await getValidatedQuery(event, query.parse)
  const user = await requireAnyPermission(event, 'server:read')
  const [row] = await liveEndpoints(user, id)
  if (!row) throw createError({ statusCode: 404, statusMessage: 'Endpoint introuvable' })
  return endpointTopology(row, { refresh: refresh === '1', progress: requestProgress(event) })
})
