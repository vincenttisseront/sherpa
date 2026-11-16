import { requirePermission } from '../../../utils/auth'
import { idParam } from '../../../utils/validation'
import { getProjectSource, toSourceDto } from '../../../services/sources'

defineRouteMeta({ openAPI: { tags: ['projects'], summary: 'Source du projet (ZIP ou GitHub), sans le token' } })

export default defineEventHandler(async (event) => {
  const { id } = await getValidatedRouterParams(event, idParam.parse)
  await requirePermission(event, 'project:read', { projectId: id })
  return toSourceDto(await getProjectSource(id))
})
