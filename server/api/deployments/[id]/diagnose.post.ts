import { z } from 'zod'
import { logAnalysisFocus } from '../../../../shared/schemas/ollama'
import { auditedAssist } from '../../../utils/ai-audit'
import { requirePermission } from '../../../utils/auth'
import { requestProgress } from '../../../utils/progress'
import { idParam, readValidated } from '../../../utils/validation'
import { diagnoseDeploymentFailure } from '../../../services/ai-assist'
import { deploymentScope } from '../../../services/deployments'

defineRouteMeta({ openAPI: { tags: ['deployments'], summary: 'Diagnostic par Ollama d\'un déploiement en échec : faits, étapes, état de la stack et journal (secrets masqués avant envoi)' } })

const body = z.object({ focus: logAnalysisFocus }).default({})

export default defineEventHandler(async (event) => {
  const { id } = await getValidatedRouterParams(event, idParam.parse)
  const scope = await deploymentScope(id)
  const user = await requirePermission(event, 'logs:read', scope)
  const { focus } = await readValidated(event, body)
  return auditedAssist(event, user, { feature: 'deploy-failure', targetType: 'deployment', targetId: id, ...scope, withQuestion: !!focus },
    () => diagnoseDeploymentFailure(id, { focus, progress: requestProgress(event) }))
})
