import type { EndpointListItem } from '../../../shared/schemas/proxy-map'
import { requireAnyPermission } from '../../utils/auth'
import { liveEndpoints } from '../../services/live'

defineRouteMeta({ openAPI: { tags: ['servers'], summary: 'Endpoints actifs accessibles (serveur et nom)' } })

export default defineEventHandler(async (event): Promise<EndpointListItem[]> => {
  const user = await requireAnyPermission(event, 'server:read')
  return (await liveEndpoints(user))
    .map(r => ({ id: r.ep.id, name: r.ep.name, serverId: r.server.id, serverName: r.server.name }))
    .sort((a, b) => a.serverName.localeCompare(b.serverName) || a.name.localeCompare(b.name))
})
