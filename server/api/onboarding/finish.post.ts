import { finishInput } from '../../../shared/schemas/onboarding'
import { requirePermission } from '../../utils/auth'
import { readValidated } from '../../utils/validation'
import { finish } from '../../services/onboarding'

defineRouteMeta({ openAPI: { tags: ['onboarding'], summary: 'Termine l\'assistant, ou le reporte (il reste accessible depuis Mise en service)' } })

export default defineEventHandler(async (event) => {
  const user = await requirePermission(event, 'policy:manage')
  const { mode } = await readValidated(event, finishInput)
  return finish(mode, user)
})
