import { accessLogQuery } from '../../../../shared/schemas/access-logs'
import { requirePermission } from '../../../utils/auth'
import { idParam } from '../../../utils/validation'
import { targetAccessLogs } from '../../../services/access-logs'
import { getTargetOr404, targetScope } from '../../../services/projects'

defineRouteMeta({ openAPI: { tags: ['targets'], summary: 'Logs d\'accès des domaines de la cible, lus sur le reverse proxy nginx de son environnement' } })

export default defineEventHandler(async (event) => {
  const { id } = await getValidatedRouterParams(event, idParam.parse)
  const t = await getTargetOr404(id)
  await requirePermission(event, 'logs:read', targetScope(t))
  return targetAccessLogs(t, await getValidatedQuery(event, accessLogQuery.parse))
})
