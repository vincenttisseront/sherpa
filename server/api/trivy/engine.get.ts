import { requireAnyPermission } from '../../utils/auth'
import { trivyEngine } from '../../services/trivy'

defineRouteMeta({ openAPI: { tags: ['vulnerabilities'], summary: 'Trivy : version en service et dernière version publiée' } })

export default defineEventHandler(async (event) => {
  await requireAnyPermission(event, 'server:read')
  return trivyEngine()
})
