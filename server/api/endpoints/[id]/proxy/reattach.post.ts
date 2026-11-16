import { z } from 'zod'
import { audit } from '../../../../utils/audit'
import { clientIp, requirePermission } from '../../../../utils/auth'
import { idParam, readValidated } from '../../../../utils/validation'
import { liveEndpoints } from '../../../../services/live'
import { reattachBehindTraefik } from '../../../../services/proxy'
import { getEndpointOr404 } from '../../../../services/servers'

defineRouteMeta({ openAPI: { tags: ['proxy'], summary: 'Rebranche un conteneur derrière Traefik : réseau du proxy rejoint (noms DNS conservés), puis redémarrage du conteneur' } })

const body = z.object({
  containerId: z.string().regex(/^[a-f0-9]{12,64}$/),
  network: z.string().min(1).max(255),
  restart: z.boolean().default(true),
})

export default defineEventHandler(async (event) => {
  const { id } = await getValidatedRouterParams(event, idParam.parse)
  const ep = await getEndpointOr404(id)
  const user = await requirePermission(event, 'network:manage', { serverId: ep.serverId })
  const input = await readValidated(event, body)
  const [row] = await liveEndpoints(user, id)
  if (!row) throw createError({ statusCode: 404, statusMessage: 'Endpoint introuvable' })
  const log = await reattachBehindTraefik(row, input.containerId, input.network, input.restart)
  await audit({ actorUserId: user.id, actorLabel: user.email, action: 'proxy.reattach', targetType: 'server_endpoint', targetId: id, serverId: ep.serverId, outcome: 'success', ip: clientIp(event), details: { container: input.containerId, network: input.network, restart: input.restart } })
  return { log }
})
