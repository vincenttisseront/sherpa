import { z } from 'zod'
import { lifecycleInput } from '../../../../shared/schemas/projects'
import type { Permission } from '../../../../shared/utils/permissions'
import { audit } from '../../../utils/audit'
import { clientIp, requirePermission } from '../../../utils/auth'
import { idParam, readValidated } from '../../../utils/validation'
import { createLifecycleAction } from '../../../services/deploy-requests'
import { getTargetOr404, targetScope } from '../../../services/projects'
import { scheduleOptions } from '../../../services/deploy-gate'

defineRouteMeta({ openAPI: { tags: ['targets'], summary: 'Arrête, démarre, redémarre, redéploie ou supprime la stack de la cible' } })

const PERMISSION: Record<string, Permission> = { stop: 'deployment:stop', start: 'deployment:execute', restart: 'deployment:execute', delete: 'deployment:delete', redeploy: 'deployment:execute' }

export default defineEventHandler(async (event) => {
  const { id } = await getValidatedRouterParams(event, idParam.parse)
  const t = await getTargetOr404(id)
  const { action, schedule } = await readValidated(event, lifecycleInput)
  const user = await requirePermission(event, PERMISSION[action]!, targetScope(t))
  const key = z.string().regex(/^[A-Za-z0-9_-]{8,128}$/).safeParse(getHeader(event, 'idempotency-key')).data ?? crypto.randomUUID()
  const deploymentId = await createLifecycleAction(t, action, user.id, `${action}:${id}:${key}`, scheduleOptions(schedule))
  await audit({ actorUserId: user.id, actorLabel: user.email, action: `target.${action}`, targetType: 'deployment', targetId: deploymentId, ...targetScope(t), outcome: 'success', ip: clientIp(event), details: { stack: t.target.stackName } })
  setResponseStatus(event, 202)
  return { deploymentId }
})
