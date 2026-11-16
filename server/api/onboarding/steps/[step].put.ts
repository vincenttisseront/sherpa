import { z } from 'zod'
import { ONBOARDING_STEPS, stepStatusInput } from '../../../../shared/schemas/onboarding'
import { requirePermission } from '../../../utils/auth'
import { readValidated } from '../../../utils/validation'
import { setStep } from '../../../services/onboarding'

defineRouteMeta({ openAPI: { tags: ['onboarding'], summary: 'Marque une étape de l\'assistant comme faite ou passée' } })

export default defineEventHandler(async (event) => {
  const user = await requirePermission(event, 'policy:manage')
  const { step } = await getValidatedRouterParams(event, z.object({ step: z.enum(ONBOARDING_STEPS) }).parse)
  const { status } = await readValidated(event, stepStatusInput)
  return setStep(step, status, user)
})
