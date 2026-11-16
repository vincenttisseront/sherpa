import { z } from 'zod'
import { audit } from '../../../../../utils/audit'
import { clientIp, requirePermission } from '../../../../../utils/auth'
import { portainer } from '../../../../../adapters/portainer'
import { liveEndpoints } from '../../../../../services/live'
import { endpointTopology } from '../../../../../services/proxy'
import { invalidateProxyMap } from '../../../../../services/proxy-map'
import { connectionFor, getEndpointOr404 } from '../../../../../services/servers'
import { MANAGED_PROXY_STACK } from '../../../../../../shared/schemas/managed-proxy'

defineRouteMeta({ openAPI: { tags: ['proxy'], summary: 'Supprime un reverse proxy sans aucune route (conteneur arrêté puis supprimé, volumes conservés)' } })

const params = z.object({ id: z.string().uuid(), cid: z.string().regex(/^[a-f0-9]{12,64}$/) })

export default defineEventHandler(async (event) => {
  const { id, cid } = await getValidatedRouterParams(event, params.parse)
  const ep = await getEndpointOr404(id)
  const user = await requirePermission(event, 'server:manage', { serverId: ep.serverId })
  const [row] = await liveEndpoints(user, id)
  if (!row) throw createError({ statusCode: 404, statusMessage: 'Endpoint introuvable' })

  // Topologie relue maintenant : la décision ne repose jamais sur un écran ancien.
  const topology = await endpointTopology(row, { refresh: true })
  const proxy = topology.proxies.find(p => p.container.id === cid || p.container.id.startsWith(cid))
  if (!proxy) throw createError({ statusCode: 404, statusMessage: 'Reverse proxy introuvable sur cet endpoint' })
  if (proxy.container.stack === MANAGED_PROXY_STACK) {
    throw createError({ statusCode: 409, statusMessage: 'Le Traefik géré par la plateforme se retire depuis son panneau, pas ici' })
  }
  if (proxy.nginx?.managed) throw createError({ statusCode: 409, statusMessage: 'Reverse proxy des projets de cet endpoint : changer d\'abord la configuration (onglet Reverse proxy)' })
  const routes = topology.routes.filter(r => r.proxyId === proxy.container.id).length
  if (routes) throw createError({ statusCode: 409, statusMessage: `Ce proxy sert encore ${routes} route(s) : les déplacer avant de le supprimer` })

  const conn = await connectionFor(row.server)
  const containers = await portainer().listContainers(conn, row.ep.portainerEndpointId)
  const c = containers.find(x => x.id === proxy.container.id)
  if (c?.labels['platform.managed'] === 'true') {
    throw createError({ statusCode: 409, statusMessage: 'Conteneur déployé par la plateforme : supprimer la stack de son projet' })
  }

  try {
    await portainer().removeContainer(conn, row.ep.portainerEndpointId, proxy.container.id)
  }
  catch (err) {
    await audit({ actorUserId: user.id, actorLabel: user.email, action: 'proxy.remove', targetType: 'server_endpoint', targetId: id, serverId: ep.serverId, outcome: 'failure', ip: clientIp(event), details: { container: proxy.container.name } })
    throw createError({ statusCode: 502, statusMessage: `Suppression refusée par l'hôte : ${(err as Error).message.slice(0, 200)}` })
  }
  invalidateProxyMap(id)
  await endpointTopology(row, { refresh: true }).catch(() => null)
  await audit({ actorUserId: user.id, actorLabel: user.email, action: 'proxy.remove', targetType: 'server_endpoint', targetId: id, serverId: ep.serverId, outcome: 'success', ip: clientIp(event), details: { container: proxy.container.name, image: proxy.container.image, stack: proxy.container.stack } })
  return {
    removed: proxy.container.name,
    // Un Compose relancé recréera le conteneur : à retirer aussi de son fichier.
    stack: proxy.container.stack,
  }
})
