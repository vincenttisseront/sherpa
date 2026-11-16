import { requirePermission } from '../../utils/auth'
import { checkGithubApis } from '../../services/onboarding'

defineRouteMeta({ openAPI: { tags: ['onboarding'], summary: 'Teste la joignabilité des API GitHub autorisées (sans token)' } })

export default defineEventHandler(async (event) => {
  await requirePermission(event, 'policy:manage')
  return checkGithubApis()
})
