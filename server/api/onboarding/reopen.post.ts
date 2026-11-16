import { requirePermission } from '../../utils/auth'
import { reopen } from '../../services/onboarding'

defineRouteMeta({ openAPI: { tags: ['onboarding'], summary: 'Rouvre l\'assistant d\'initialisation' } })

export default defineEventHandler(async (event) => {
  const user = await requirePermission(event, 'policy:manage')
  return reopen(user)
})
