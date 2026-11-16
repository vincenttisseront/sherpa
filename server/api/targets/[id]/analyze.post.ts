import { requestProgress } from '../../../utils/progress'
import { deployInput } from '../../../../shared/schemas/projects'
import { requirePermission } from '../../../utils/auth'
import { idParam, readValidated } from '../../../utils/validation'
import { previewDeployment } from '../../../services/deploy-requests'
import { getTargetOr404, targetScope } from '../../../services/projects'

defineRouteMeta({ openAPI: { tags: ['targets'], summary: 'Analyse un Compose (sans rien déployer) : problèmes, ports, volumes, réseaux, Compose final et diff' } })

export default defineEventHandler(async (event) => {
  const { id } = await getValidatedRouterParams(event, idParam.parse)
  const t = await getTargetOr404(id)
  await requirePermission(event, 'deployment:execute', targetScope(t))
  const input = await readValidated(event, deployInput)
  return previewDeployment(t, input.uploadId, input.composePath, input.portApprovals, requestProgress(event))
})
