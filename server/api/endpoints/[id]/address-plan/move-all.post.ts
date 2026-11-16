import { z } from 'zod'
import { audit } from '../../../../utils/audit'
import { clientIp, requirePermission } from '../../../../utils/auth'
import { idParam, readValidated } from '../../../../utils/validation'
import { moveAll } from '../../../../services/address-plan'
import { getEndpointOr404 } from '../../../../services/servers'

defineRouteMeta({ openAPI: { tags: ['endpoints'], summary: 'Déplace vers la plage de l\'endpoint tous les réseaux surdimensionnés ou en conflit (dryRun : plan seul)' } })

export default defineEventHandler(async (event) => {
  const { id } = await getValidatedRouterParams(event, idParam.parse)
  const ep = await getEndpointOr404(id)
  const user = await requirePermission(event, 'network:manage', { serverId: ep.serverId })
  const { dryRun } = await readValidated(event, z.object({ dryRun: z.boolean().default(true) }))
  const r = await moveAll(id, user, dryRun)
  if (!dryRun) await audit({ actorUserId: user.id, actorLabel: user.email, action: 'network.move_all', targetType: 'server_endpoint', targetId: id, serverId: ep.serverId, outcome: r.moves.some(m => m.error) ? 'failure' : 'success', ip: clientIp(event), details: { moves: r.moves, deployments: r.deployments } })
  return r
})
