import { z } from 'zod'
import { logAnalysisFocus } from '../../../../../shared/schemas/ollama'
import { auditedAssist } from '../../../../utils/ai-audit'
import { canOn, requirePermission } from '../../../../utils/auth'
import { requestProgress } from '../../../../utils/progress'
import { idParam, readValidated } from '../../../../utils/validation'
import { getTargetOr404, targetScope } from '../../../../services/projects'
import { summarizeTechSupport } from '../../../../services/ai-assist'

defineRouteMeta({ openAPI: { tags: ['targets'], summary: 'Synthèse par Ollama du rapport tech support de la cible, avec un texte de ticket (secrets masqués avant envoi)' } })

const body = z.object({ focus: logAnalysisFocus }).default({})

export default defineEventHandler(async (event) => {
  const { id } = await getValidatedRouterParams(event, idParam.parse)
  const t = await getTargetOr404(id)
  const scope = targetScope(t)
  const user = await requirePermission(event, 'project:read', scope)
  const { focus } = await readValidated(event, body)
  return auditedAssist(event, user, { feature: 'support', targetType: 'project_target', targetId: id, ...scope, withQuestion: !!focus },
    () => summarizeTechSupport(t, { logs: canOn(user, 'logs:read', scope), by: user.email, focus, progress: requestProgress(event) }))
})
