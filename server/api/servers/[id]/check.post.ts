import { requirePermission } from '../../../utils/auth'
import { idParam } from '../../../utils/validation'
import { checkServerHealth, getServerOr404, loadServerDetail } from '../../../services/servers'

defineRouteMeta({ openAPI: { tags: ['servers'], summary: 'Contrôle immédiat de la connexion et des endpoints' } })

export default defineEventHandler(async (event) => {
  const { id } = await getValidatedRouterParams(event, idParam.parse)
  await requirePermission(event, 'server:read', { serverId: id })
  await checkServerHealth(await getServerOr404(id))
  return loadServerDetail(id)
})
