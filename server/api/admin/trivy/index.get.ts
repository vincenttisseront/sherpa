import { requirePermission } from '../../../utils/auth'
import { trivyStatus } from '../../../services/trivy'

defineRouteMeta({ openAPI: { tags: ['admin'], summary: 'Réglages de l\'analyse de vulnérabilités (Trivy) et dernière analyse' } })

export default defineEventHandler(async (event) => {
  await requirePermission(event, 'policy:manage')
  return trivyStatus()
})
