import { watchtowerProfileInput } from '../../../../../shared/schemas/watchtower'
import { audit } from '../../../../utils/audit'
import { clientIp, requirePermission } from '../../../../utils/auth'
import { idParam, readValidated } from '../../../../utils/validation'
import { getEndpointOr404 } from '../../../../services/servers'
import { createProfile, profileDto } from '../../../../services/watchtower-profiles'

defineRouteMeta({ openAPI: { tags: ['watchtower'], summary: 'Crée un profil Watchtower sur l\'endpoint' } })

export default defineEventHandler(async (event) => {
  const { id } = await getValidatedRouterParams(event, idParam.parse)
  const ep = await getEndpointOr404(id)
  const user = await requirePermission(event, 'server:manage', { serverId: ep.serverId })
  const input = await readValidated(event, watchtowerProfileInput)
  const p = await createProfile(id, input)
  await audit({ actorUserId: user.id, actorLabel: user.email, action: 'watchtower.profile_created', targetType: 'server_endpoint', targetId: id, serverId: ep.serverId, outcome: 'success', ip: clientIp(event), details: { profile: p.id, ...input } })
  setResponseStatus(event, 201)
  return profileDto(p)
})
