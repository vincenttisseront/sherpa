import { z } from 'zod'
import { rebuildInput } from '../../../../shared/schemas/rebuild'
import { audit } from '../../../utils/audit'
import { clientIp, requirePermission } from '../../../utils/auth'
import { requestProgress } from '../../../utils/progress'
import { idParam, readValidated } from '../../../utils/validation'
import { getTargetOr404, targetScope } from '../../../services/projects'
import { startRebuild } from '../../../services/rebuild'

defineRouteMeta({ openAPI: { tags: ['targets'], summary: 'Reconstruit la cible sur la dernière version de sa source (images reconstruites, build propre facultatif)' } })

export default defineEventHandler(async (event) => {
  const { id } = await getValidatedRouterParams(event, idParam.parse)
  const t = await getTargetOr404(id)
  const user = await requirePermission(event, 'deployment:execute', targetScope(t))
  const input = await readValidated(event, rebuildInput)
  const key = z.string().regex(/^[A-Za-z0-9_-]{8,128}$/).safeParse(getHeader(event, 'idempotency-key')).data ?? crypto.randomUUID()
  try {
    const r = await startRebuild(t, { cleanBuild: input.cleanBuild, userId: user.id, idempotencyKey: `rebuild:${id}:${key}`, progress: requestProgress(event) })
    await audit({ actorUserId: user.id, actorLabel: user.email, action: 'target.rebuild', targetType: 'deployment', targetId: r.deploymentId, ...targetScope(t), outcome: 'success', ip: clientIp(event), details: { mode: r.plan.mode, from: r.plan.current?.label ?? null, to: r.plan.latest?.label ?? null, cleanBuild: input.cleanBuild } })
    setResponseStatus(event, 202)
    return { deploymentId: r.deploymentId, plan: r.plan }
  }
  catch (err) {
    await audit({ actorUserId: user.id, actorLabel: user.email, action: 'target.rebuild', targetType: 'project_target', targetId: id, ...targetScope(t), outcome: 'failure', ip: clientIp(event), details: { error: (err as Error).message } })
    throw err
  }
})
