import { requirePermission } from '../../../../utils/auth'
import { idParam } from '../../../../utils/validation'
import { getTargetOr404, targetScope } from '../../../../services/projects'
import { getTargetWatchtower } from '../../../../services/watchtower'

defineRouteMeta({ openAPI: { tags: ['watchtower'], summary: 'Configuration Watchtower de la cible, provenance et historique des images' } })

export default defineEventHandler(async (event) => {
  const { id } = await getValidatedRouterParams(event, idParam.parse)
  const t = await getTargetOr404(id)
  await requirePermission(event, 'project:read', targetScope(t))
  return getTargetWatchtower(t)
})
