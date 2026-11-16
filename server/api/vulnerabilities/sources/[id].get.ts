import { requireAnyPermission } from '../../../utils/auth'
import { idParam } from '../../../utils/validation'
import { liveEndpoints } from '../../../services/live'
import { sourceScanDetail } from '../../../services/trivy'

defineRouteMeta({ openAPI: { tags: ['vulnerabilities'], summary: 'Vulnérabilités des dépendances du code source d\'une cible (fichier, paquet, version corrigée)' } })

export default defineEventHandler(async (event) => {
  const { id } = await getValidatedRouterParams(event, idParam.parse)
  const user = await requireAnyPermission(event, 'server:read')
  const scan = await sourceScanDetail(id)
  if (!scan || !(await liveEndpoints(user, scan.endpointId)).length) throw createError({ statusCode: 404, statusMessage: 'Analyse introuvable' })
  return scan
})
