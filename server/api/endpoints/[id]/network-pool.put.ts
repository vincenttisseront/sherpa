import { z } from 'zod'
import { networkPoolInput } from '../../../../shared/schemas/network-pool'
import { audit } from '../../../utils/audit'
import { clientIp, requirePermission } from '../../../utils/auth'
import { idParam, readValidated } from '../../../utils/validation'
import { getNetworkPool, setNetworkPool } from '../../../services/network-pool'
import { getEndpointOr404 } from '../../../services/servers'

defineRouteMeta({ openAPI: { tags: ['endpoints'], summary: 'Définit (ou retire, pool: null) la plage d\'adresses des réseaux des projets de l\'endpoint' } })

const body = z.object({ pool: networkPoolInput.nullable() })

export default defineEventHandler(async (event) => {
  const { id } = await getValidatedRouterParams(event, idParam.parse)
  const ep = await getEndpointOr404(id)
  const user = await requirePermission(event, 'network:manage', { serverId: ep.serverId })
  const { pool } = await readValidated(event, body)
  const r = await setNetworkPool(id, pool)
  await audit({ actorUserId: user.id, actorLabel: user.email, action: 'endpoint.network_pool', targetType: 'server_endpoint', targetId: id, serverId: ep.serverId, outcome: 'success', ip: clientIp(event), details: { pool, released: r.released } })
  return { ...(await getNetworkPool(id)), released: r.released }
})
