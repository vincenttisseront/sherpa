import { requestProgress } from '../../../utils/progress'
import type { DiscoveryReport } from '../../../../shared/schemas/servers'
import { audit } from '../../../utils/audit'
import { clientIp, requirePermission } from '../../../utils/auth'
import { idParam } from '../../../utils/validation'
import { getServerOr404, portainerErrorMessage, rediscover } from '../../../services/servers'

defineRouteMeta({ openAPI: { tags: ['servers'], summary: 'Relance la découverte (endpoints, réseaux, volumes, inventaire)' } })

export default defineEventHandler(async (event): Promise<DiscoveryReport> => {
  const { id } = await getValidatedRouterParams(event, idParam.parse)
  const user = await requirePermission(event, 'server:manage', { serverId: id })
  const server = await getServerOr404(id)
  try {
    const report = await rediscover(server, requestProgress(event))
    await audit({ actorUserId: user.id, actorLabel: user.email, action: 'server.discover', targetType: 'portainer_server', targetId: id, serverId: id, outcome: 'success', ip: clientIp(event), details: { ...report } })
    return report
  }
  catch (err) {
    const message = portainerErrorMessage(err)
    await audit({ actorUserId: user.id, actorLabel: user.email, action: 'server.discover', targetType: 'portainer_server', targetId: id, serverId: id, outcome: 'failure', ip: clientIp(event), details: { error: message } })
    throw createError({ statusCode: 422, statusMessage: message })
  }
})
