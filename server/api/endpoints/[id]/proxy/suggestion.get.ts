import { requestProgress } from '../../../../utils/progress'
import { idParam } from '../../../../utils/validation'
import { requireAnyPermission } from '../../../../utils/auth'
import { liveEndpoints } from '../../../../services/live'
import { endpointSuggestion } from '../../../../services/proxy'

defineRouteMeta({ openAPI: { tags: ['proxy'], summary: 'Reverse proxy détecté (Traefik, nginx-proxy, nginx ou conteneur publiant 80/443) et configuration proposée ; ?container= pour choisir un candidat (rien n\'est enregistré)' } })

export default defineEventHandler(async (event) => {
  const { id } = await getValidatedRouterParams(event, idParam.parse)
  const user = await requireAnyPermission(event, 'server:read')
  const [row] = await liveEndpoints(user, id)
  if (!row) throw createError({ statusCode: 404, statusMessage: 'Endpoint introuvable' })
  const { container } = getQuery(event)
  return endpointSuggestion(row, requestProgress(event), typeof container === 'string' && container ? container.slice(0, 200) : undefined)
})
