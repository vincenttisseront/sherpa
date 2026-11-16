import { deployPolicyInput } from '../../../../shared/schemas/deploy-gate'
import { getPolicy, setPolicy } from '../../../services/deploy-gate'
import { audit } from '../../../utils/audit'
import { clientIp, requirePermission } from '../../../utils/auth'
import { readValidated } from '../../../utils/validation'

defineRouteMeta({ openAPI: { tags: ['admin'], summary: 'Définit la politique de déploiement d\'un environnement (validation, fuseau, fenêtres)' } })

export default defineEventHandler(async (event) => {
  const user = await requirePermission(event, 'policy:manage')
  const input = await readValidated(event, deployPolicyInput)
  const before = await getPolicy(input.environmentId)
  await setPolicy(input, user.id)
  await audit({ actorUserId: user.id, actorLabel: user.email, action: 'policy.deploy_gate', targetType: 'environment', targetId: input.environmentId, environmentId: input.environmentId, outcome: 'success', ip: clientIp(event), details: { before, after: { requireApproval: input.requireApproval, timezone: input.timezone, windows: input.windows } } })
  return { ok: true }
})
