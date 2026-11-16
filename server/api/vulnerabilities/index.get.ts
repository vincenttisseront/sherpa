import { requireAnyPermission } from '../../utils/auth'
import { liveEndpoints } from '../../services/live'
import { listImageScans, listSourceScans, trivyStatus } from '../../services/trivy'
import { listRemediationRequests } from '../../services/remediation'

defineRouteMeta({ openAPI: { tags: ['vulnerabilities'], summary: 'Vulnérabilités des images en service et des dépendances du code source (dernière analyse Trivy), état de l\'analyse et réglages' } })

export default defineEventHandler(async (event) => {
  const user = await requireAnyPermission(event, 'server:read')
  const eps = await liveEndpoints(user)
  const ids = eps.map(e => e.ep.id)
  return { status: await trivyStatus(), images: await listImageScans(ids), sources: await listSourceScans(ids), requests: await listRemediationRequests(ids) }
})
