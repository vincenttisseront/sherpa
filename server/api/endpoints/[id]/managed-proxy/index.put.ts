import { managedProxyInput } from '../../../../../shared/schemas/managed-proxy'
import { audit } from '../../../../utils/audit'
import { clientIp, requireAnyPermission, requirePermission } from '../../../../utils/auth'
import { idParam, readValidated } from '../../../../utils/validation'
import { liveEndpoints } from '../../../../services/live'
import { saveManagedProxy } from '../../../../services/managed-proxy'

defineRouteMeta({ openAPI: { tags: ['proxy'], summary: 'Enregistre la configuration du Traefik géré (sans l\'appliquer)' } })

export default defineEventHandler(async (event) => {
  const { id } = await getValidatedRouterParams(event, idParam.parse)
  const reader = await requireAnyPermission(event, 'server:read')
  const [row] = await liveEndpoints(reader, id)
  if (!row) throw createError({ statusCode: 404, statusMessage: 'Endpoint introuvable' })
  const user = await requirePermission(event, 'server:manage', { serverId: row.server.id })
  const input = await readValidated(event, managedProxyInput)
  const dto = await saveManagedProxy(row.ep.id, input, user.id)
  await audit({ actorUserId: user.id, actorLabel: user.email, action: 'proxy.configure', targetType: 'server_endpoint', targetId: row.ep.id, serverId: row.server.id, outcome: 'success', ip: clientIp(event), details: { config: input.config, dnsEnv: input.dnsEnv.map(v => v.name) } })
  return dto
})
