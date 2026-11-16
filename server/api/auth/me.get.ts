import { meOf } from '../../auth/me'
import { setupRequired } from '../../auth/setup'
import { onboardingPending } from '../../services/onboarding'
import { canOn } from '../../utils/auth'

defineRouteMeta({ openAPI: { tags: ['auth'], summary: 'Utilisateur connecté, droits effectifs et jeton CSRF' } })

export default defineEventHandler(async (event) => {
  const me = meOf(event)
  if (!me) return { authenticated: false, setupRequired: await setupRequired() }
  if (event.context.user && canOn(event.context.user, 'policy:manage', {})) me.onboardingPending = await onboardingPending()
  return me
})
