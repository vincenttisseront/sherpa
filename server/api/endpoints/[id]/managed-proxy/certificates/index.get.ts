import { requireAnyPermission } from '../../../../../utils/auth'
import { idParam } from '../../../../../utils/validation'
import { liveEndpoints } from '../../../../../services/live'
import { listCertificates } from '../../../../../services/proxy-certificates'

defineRouteMeta({ openAPI: { tags: ['proxy'], summary: 'Certificats importés pour le Traefik géré (domaines, émetteur, expiration, domaines exposés couverts ; jamais la clé)' } })

export default defineEventHandler(async (event) => {
  const { id } = await getValidatedRouterParams(event, idParam.parse)
  const user = await requireAnyPermission(event, 'server:read')
  const [row] = await liveEndpoints(user, id)
  if (!row) throw createError({ statusCode: 404, statusMessage: 'Endpoint introuvable' })
  return listCertificates(row.ep.id)
})
