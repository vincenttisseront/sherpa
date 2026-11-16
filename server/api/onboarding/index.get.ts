import { requirePermission } from '../../utils/auth'
import { getOnboarding, onboardingFacts } from '../../services/onboarding'

defineRouteMeta({ openAPI: { tags: ['onboarding'], summary: 'Assistant d\'initialisation : progression et état réel de chaque domaine' } })

export default defineEventHandler(async (event) => {
  await requirePermission(event, 'policy:manage')
  const [state, facts] = await Promise.all([getOnboarding(), onboardingFacts()])
  return { state, facts }
})
