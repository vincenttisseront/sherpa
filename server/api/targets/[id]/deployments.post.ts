import { requestProgress } from '../../../utils/progress'
import { z } from 'zod'
import { deployInput, githubAnalyzeInput } from '../../../../shared/schemas/projects'
import { audit } from '../../../utils/audit'
import { clientIp, requirePermission } from '../../../utils/auth'
import { idParam, readValidated } from '../../../utils/validation'
import { createDeployment, createGithubDeployment } from '../../../services/deploy-requests'
import { getTargetOr404, targetScope } from '../../../services/projects'
import { scheduleOptions } from '../../../services/deploy-gate'

defineRouteMeta({ openAPI: { tags: ['targets'], summary: 'Lance un déploiement (analyse refaite côté serveur ; en-tête Idempotency-Key recommandé)' } })

export default defineEventHandler(async (event) => {
  const { id } = await getValidatedRouterParams(event, idParam.parse)
  const t = await getTargetOr404(id)
  const user = await requirePermission(event, 'deployment:execute', targetScope(t))
  const body = await readBody(event).catch(() => ({})) as { source?: string }
  const key = z.string().regex(/^[A-Za-z0-9_-]{8,128}$/).safeParse(getHeader(event, 'idempotency-key')).data ?? crypto.randomUUID()
  try {
    if (body?.source === 'github') {
      const input = await readValidated(event, githubAnalyzeInput)
      const r = await createGithubDeployment(t, { ...input, options: scheduleOptions(input.schedule), idempotencyKey: `deploy:${id}:${key}`, userId: user.id, progress: requestProgress(event) })
      if (!r.duplicate) await audit({ actorUserId: user.id, actorLabel: user.email, action: 'deployment.create', targetType: 'deployment', targetId: r.deploymentId, ...targetScope(t), outcome: 'success', ip: clientIp(event), details: { source: 'github', commit: r.commitSha, ref: input.ref, approvals: input.portApprovals, environment: t.env.key } })
      setResponseStatus(event, r.duplicate ? 200 : 202)
      return { deploymentId: r.deploymentId, duplicate: r.duplicate, commitSha: r.commitSha }
    }
    const input = await readValidated(event, deployInput)
    const r = await createDeployment(t, { ...input, options: scheduleOptions(input.schedule), idempotencyKey: `deploy:${id}:${key}`, userId: user.id, progress: requestProgress(event) })
    if (!r.duplicate) {
      await audit({ actorUserId: user.id, actorLabel: user.email, action: 'deployment.create', targetType: 'deployment', targetId: r.deploymentId, ...targetScope(t), outcome: 'success', ip: clientIp(event), details: { uploadId: input.uploadId, composePath: input.composePath, approvals: input.portApprovals, environment: t.env.key } })
    }
    setResponseStatus(event, r.duplicate ? 200 : 202)
    return { deploymentId: r.deploymentId, duplicate: r.duplicate }
  }
  catch (err) {
    await audit({ actorUserId: user.id, actorLabel: user.email, action: 'deployment.create', targetType: 'project_target', targetId: id, ...targetScope(t), outcome: 'failure', ip: clientIp(event), details: { error: (err as Error).message } })
    throw err
  }
})
