import type { WatchtowerProfileDto } from '../../../../../shared/schemas/watchtower'
import { requirePermission } from '../../../../utils/auth'
import { idParam } from '../../../../utils/validation'
import { getEndpointOr404 } from '../../../../services/servers'
import { listProfiles } from '../../../../services/watchtower-profiles'

defineRouteMeta({ openAPI: { tags: ['watchtower'], summary: 'Profils Watchtower de l\'endpoint : réglages, état réel du conteneur, projets rattachés' } })

export default defineEventHandler(async (event): Promise<WatchtowerProfileDto[]> => {
  const { id } = await getValidatedRouterParams(event, idParam.parse)
  const ep = await getEndpointOr404(id)
  await requirePermission(event, 'server:read', { serverId: ep.serverId })
  return listProfiles(id)
})
