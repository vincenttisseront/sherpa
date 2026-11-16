import { requirePermission } from '../../../../utils/auth'
import { idParam } from '../../../../utils/validation'
import { getTargetOr404, targetScope } from '../../../../services/projects'
import { resolvePending } from '../../../../services/pending'

defineRouteMeta({ openAPI: { tags: ['targets'], summary: 'Vérifie l\'action en attente de la cible (condition contrôlée par la plateforme) et la lève si elle est faite' } })

export default defineEventHandler(async (event) => {
  const { id } = await getValidatedRouterParams(event, idParam.parse)
  const t = await getTargetOr404(id)
  const user = await requirePermission(event, 'project:read', targetScope(t))
  const status = await resolvePending(id, user.email)
  return status ?? { done: true, missing: null, link: `/projects/${t.project.id}` }
})
