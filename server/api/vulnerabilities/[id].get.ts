import { requireAnyPermission } from '../../utils/auth'
import { idParam } from '../../utils/validation'
import { liveEndpoints } from '../../services/live'
import { imageScanDetail } from '../../services/trivy'

defineRouteMeta({ openAPI: { tags: ['vulnerabilities'], summary: 'Vulnérabilités d\'une image (CVE, paquet, version corrigée)' } })

export default defineEventHandler(async (event) => {
  const { id } = await getValidatedRouterParams(event, idParam.parse)
  const user = await requireAnyPermission(event, 'server:read')
  const scan = await imageScanDetail(id)
  if (!scan || !(await liveEndpoints(user, scan.endpointId)).length) throw createError({ statusCode: 404, statusMessage: 'Analyse introuvable' })
  return scan
})
