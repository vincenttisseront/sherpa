import { requirePermission } from '../../../utils/auth'
import { requestProgress } from '../../../utils/progress'
import { idParam } from '../../../utils/validation'
import { prepareAdoptionUpload } from '../../../services/adoption'
import { getTargetOr404, targetScope } from '../../../services/projects'

defineRouteMeta({ openAPI: { tags: ['adoption'], summary: 'Prépare à nouveau l\'archive du Compose converti d\'une stack reprise, avant sa première mise en gestion' } })

export default defineEventHandler(async (event) => {
  const { id } = await getValidatedRouterParams(event, idParam.parse)
  const t = await getTargetOr404(id)
  const user = await requirePermission(event, 'deployment:execute', targetScope(t))
  return prepareAdoptionUpload(t, user.id, requestProgress(event))
})
