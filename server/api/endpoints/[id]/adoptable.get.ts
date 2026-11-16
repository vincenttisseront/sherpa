import { requireAnyPermission } from '../../../utils/auth'
import { idParam } from '../../../utils/validation'
import { liveEndpoints } from '../../../services/live'
import { listAdoptable } from '../../../services/adoption'
import { portainerErrorMessage } from '../../../services/servers'
import { PortainerError } from '../../../adapters/portainer/types'

defineRouteMeta({ openAPI: { tags: ['adoption'], summary: 'Stacks Compose présentes sur l\'endpoint, gérées ou non par la plateforme' } })

export default defineEventHandler(async (event) => {
  const { id } = await getValidatedRouterParams(event, idParam.parse)
  const user = await requireAnyPermission(event, 'server:read')
  const [row] = await liveEndpoints(user, id)
  if (!row) throw createError({ statusCode: 404, statusMessage: 'Endpoint introuvable' })
  try {
    return await listAdoptable(row)
  }
  catch (err) {
    // Hôte injoignable (agent arrêté, SSH refusé…) : message lisible plutôt qu'une erreur 500.
    if (err instanceof PortainerError) throw createError({ statusCode: 502, statusMessage: `${row.server.name} : ${portainerErrorMessage(err)}` })
    throw err
  }
})
