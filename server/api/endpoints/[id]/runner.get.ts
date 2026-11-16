import { requirePermission } from '../../../utils/auth'
import { idParam } from '../../../utils/validation'
import { type RunnerDto, toRunnerDto } from '../../../services/runner-admin'
import { getEndpointOr404 } from '../../../services/servers'

defineRouteMeta({ openAPI: { tags: ['runner'], summary: 'Configuration et état du Target Runner de l\'endpoint (sans secret)' } })

export default defineEventHandler(async (event): Promise<RunnerDto> => {
  const { id } = await getValidatedRouterParams(event, idParam.parse)
  const ep = await getEndpointOr404(id)
  await requirePermission(event, 'server:read', { serverId: ep.serverId })
  return toRunnerDto(id)
})
