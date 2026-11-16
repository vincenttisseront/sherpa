import { requireAnyPermission } from '../../../../utils/auth'
import { idParam } from '../../../../utils/validation'
import { liveEndpoints } from '../../../../services/live'
import { previewManagedProxy } from '../../../../services/managed-proxy'

defineRouteMeta({ openAPI: { tags: ['proxy'], summary: 'Aperçu du Traefik géré : Compose généré, réseaux à créer, conflits de ports' } })

export default defineEventHandler(async (event) => {
  const { id } = await getValidatedRouterParams(event, idParam.parse)
  const user = await requireAnyPermission(event, 'server:read')
  const [row] = await liveEndpoints(user, id)
  if (!row) throw createError({ statusCode: 404, statusMessage: 'Endpoint introuvable' })
  return previewManagedProxy(row)
})
