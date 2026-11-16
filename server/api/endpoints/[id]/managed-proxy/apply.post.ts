import { audit } from '../../../../utils/audit'
import { clientIp, requireAnyPermission, requirePermission } from '../../../../utils/auth'
import { requestProgress } from '../../../../utils/progress'
import { idParam } from '../../../../utils/validation'
import { liveEndpoints } from '../../../../services/live'
import { applyManagedProxy } from '../../../../services/managed-proxy'
import { portainerErrorMessage } from '../../../../services/servers'

defineRouteMeta({ openAPI: { tags: ['proxy'], summary: 'Déploie ou met à jour le Traefik géré sur l\'endpoint, puis aligne la configuration Traefik' } })

export default defineEventHandler(async (event) => {
  const { id } = await getValidatedRouterParams(event, idParam.parse)
  const reader = await requireAnyPermission(event, 'server:read')
  const [row] = await liveEndpoints(reader, id)
  if (!row) throw createError({ statusCode: 404, statusMessage: 'Endpoint introuvable' })
  const user = await requirePermission(event, 'server:manage', { serverId: row.server.id })
  try {
    const dto = await applyManagedProxy(row, requestProgress(event))
    await audit({ actorUserId: user.id, actorLabel: user.email, action: 'proxy.apply', targetType: 'server_endpoint', targetId: row.ep.id, serverId: row.server.id, outcome: 'success', ip: clientIp(event), details: { endpoint: row.ep.name, config: dto.config } })
    return dto
  }
  catch (err) {
    await audit({ actorUserId: user.id, actorLabel: user.email, action: 'proxy.apply', targetType: 'server_endpoint', targetId: row.ep.id, serverId: row.server.id, outcome: 'failure', ip: clientIp(event), details: { endpoint: row.ep.name, error: portainerErrorMessage(err) } })
    throw err
  }
})
