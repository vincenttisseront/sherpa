import { networkMoveInput } from '../../../../../shared/schemas/address-plan'
import type { NetworkMoveResult } from '../../../../../shared/schemas/address-plan'
import { audit } from '../../../../utils/audit'
import { clientIp, requirePermission } from '../../../../utils/auth'
import { idParam, readValidated } from '../../../../utils/validation'
import { moveNetwork } from '../../../../services/address-plan'
import { getEndpointOr404 } from '../../../../services/servers'

defineRouteMeta({ openAPI: { tags: ['endpoints'], summary: 'Déplace un réseau vers un autre sous-réseau (dryRun : plan seul) : redéploiement pour un projet de la console, recréation en direct sinon' } })

export default defineEventHandler(async (event): Promise<NetworkMoveResult> => {
  const { id } = await getValidatedRouterParams(event, idParam.parse)
  const ep = await getEndpointOr404(id)
  const user = await requirePermission(event, 'network:manage', { serverId: ep.serverId })
  const input = await readValidated(event, networkMoveInput)
  const r = await moveNetwork(id, input, user)
  if (!input.dryRun) {
    await audit({ actorUserId: user.id, actorLabel: user.email, action: 'network.move', targetType: 'server_endpoint', targetId: id, serverId: ep.serverId, outcome: 'success', ip: clientIp(event), details: { network: r.plan.network, from: r.plan.from, to: r.plan.to, mode: r.plan.mode, deploymentId: r.deploymentId ?? null } })
  }
  return r
})
