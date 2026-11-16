import { z } from 'zod'
import { requireAnyPermission } from '../../utils/auth'
import { liveEndpoints, scanEndpoint } from '../../services/live'

defineRouteMeta({ openAPI: { tags: ['live'], summary: 'Conteneurs des endpoints gérés, lus en direct (lecture seule)' } })

export default defineEventHandler(async (event) => {
  const user = await requireAnyPermission(event, 'server:read')
  const { endpointId } = await getValidatedQuery(event, z.object({ endpointId: z.uuid().optional() }).parse)
  const rows = await liveEndpoints(user, endpointId)
  if (endpointId && !rows.length) throw createError({ statusCode: 404, statusMessage: 'Endpoint introuvable' })
  return Promise.all(rows.map(scanEndpoint))
})
