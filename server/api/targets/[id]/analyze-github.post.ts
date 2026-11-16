import { requestProgress } from '../../../utils/progress'
import { githubAnalyzeInput } from '../../../../shared/schemas/projects'
import { requirePermission } from '../../../utils/auth'
import { idParam, readValidated } from '../../../utils/validation'
import { getTargetOr404, targetScope } from '../../../services/projects'
import { previewGithub } from '../../../services/sources'

defineRouteMeta({ openAPI: { tags: ['targets'], summary: 'Analyse depuis GitHub : commit résolu, Compose lu au commit exact, analyse complète' } })

export default defineEventHandler(async (event) => {
  const { id } = await getValidatedRouterParams(event, idParam.parse)
  const t = await getTargetOr404(id)
  await requirePermission(event, 'deployment:execute', targetScope(t))
  const input = await readValidated(event, githubAnalyzeInput)
  const { composeText: _, files: __, ...preview } = await previewGithub(t, { refType: input.refType, ref: input.ref, commitSha: input.commitSha, approvals: input.portApprovals, releaseSlug: 'r-xxxx-xxxxxx', exposures: input.exposures, progress: requestProgress(event) })
  return preview
})
