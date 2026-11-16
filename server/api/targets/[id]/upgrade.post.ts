import { z } from 'zod'
import { upgradeInput } from '../../../../shared/schemas/image-upgrade'
import { audit } from '../../../utils/audit'
import { clientIp, requirePermission } from '../../../utils/auth'
import { idParam, readValidated } from '../../../utils/validation'
import { applyUpgrade } from '../../../services/image-upgrade'
import { getTargetOr404, targetScope } from '../../../services/projects'

defineRouteMeta({ openAPI: { tags: ['targets'], summary: 'Met à niveau les images de la cible (versions choisies, build propre) et redéploie ; retour automatique aux images précédentes en cas d\'échec' } })

export default defineEventHandler(async (event) => {
  const { id } = await getValidatedRouterParams(event, idParam.parse)
  const t = await getTargetOr404(id)
  const user = await requirePermission(event, 'deployment:execute', targetScope(t))
  const input = await readValidated(event, upgradeInput)
  const key = z.string().regex(/^[A-Za-z0-9_-]{8,128}$/).safeParse(getHeader(event, 'idempotency-key')).data ?? crypto.randomUUID()
  const r = await applyUpgrade(t, input, user, `upgrade:${id}:${key}`)
  await audit({ actorUserId: user.id, actorLabel: user.email, action: 'target.upgrade', targetType: 'deployment', targetId: r.deploymentId, ...targetScope(t), outcome: 'success', ip: clientIp(event), details: { services: r.services, cleanBuild: input.cleanBuild, confirmMajorData: input.confirmMajorData } })
  setResponseStatus(event, 202)
  return r
})
