import type { ServerDetailDto } from '../../../shared/schemas/servers'
import { requirePermission } from '../../utils/auth'
import { idParam } from '../../utils/validation'
import { loadServerDetail } from '../../services/servers'

defineRouteMeta({ openAPI: { tags: ['servers'], summary: 'Détail d\'un serveur et de ses endpoints (sans secret)' } })

export default defineEventHandler(async (event): Promise<ServerDetailDto> => {
  const { id } = await getValidatedRouterParams(event, idParam.parse)
  await requirePermission(event, 'server:read', { serverId: id })
  return loadServerDetail(id)
})
