import { requireAnyPermission } from '../../../../utils/auth'
import { idParam } from '../../../../utils/validation'
import { liveEndpoints } from '../../../../services/live'
import { getManagedProxy } from '../../../../services/managed-proxy'

defineRouteMeta({ openAPI: { tags: ['proxy'], summary: 'Traefik géré par la plateforme : configuration (sans secrets) et état' } })

export default defineEventHandler(async (event) => {
  const { id } = await getValidatedRouterParams(event, idParam.parse)
  const user = await requireAnyPermission(event, 'server:read')
  const [row] = await liveEndpoints(user, id)
  if (!row) throw createError({ statusCode: 404, statusMessage: 'Endpoint introuvable' })
  return getManagedProxy(row.ep.id)
})
