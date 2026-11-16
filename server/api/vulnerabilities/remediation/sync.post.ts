import { requireAnyPermission } from '../../../utils/auth'
import { syncRemediationRequests } from '../../../services/remediation'

defineRouteMeta({ openAPI: { tags: ['vulnerabilities'], summary: 'Met à jour l\'état des demandes de correction (GitHub) et leur résolution (analyses)' } })

export default defineEventHandler(async (event) => {
  await requireAnyPermission(event, 'deployment:execute')
  return syncRemediationRequests()
})
