import type { TargetDiagnostic } from '../../../../shared/schemas/diagnostic'
import { canOn, requirePermission } from '../../../utils/auth'
import { idParam } from '../../../utils/validation'
import { diagnoseTarget } from '../../../services/diagnostic'
import { getTargetOr404, targetScope } from '../../../services/projects'

defineRouteMeta({ openAPI: { tags: ['targets'], summary: 'Diagnostic de la cible : état réel des services, cause probable (sortie, OOM, healthcheck, logs notables) et actions proposées' } })

export default defineEventHandler(async (event): Promise<TargetDiagnostic> => {
  const { id } = await getValidatedRouterParams(event, idParam.parse)
  const t = await getTargetOr404(id)
  const user = await requirePermission(event, 'project:read', targetScope(t))
  return diagnoseTarget(t, { logs: canOn(user, 'logs:read', targetScope(t)) })
})
