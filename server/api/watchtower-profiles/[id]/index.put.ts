import { watchtowerProfileInput } from '../../../../shared/schemas/watchtower'
import { audit } from '../../../utils/audit'
import { clientIp, requirePermission } from '../../../utils/auth'
import { idParam, readValidated } from '../../../utils/validation'
import { getEndpointOr404 } from '../../../services/servers'
import { getProfileOr404, profileDto, updateProfile } from '../../../services/watchtower-profiles'

defineRouteMeta({ openAPI: { tags: ['watchtower'], summary: 'Modifie un profil Watchtower (appliqué ensuite au conteneur du profil)' } })

export default defineEventHandler(async (event) => {
  const { id } = await getValidatedRouterParams(event, idParam.parse)
  const current = await getProfileOr404(id)
  const ep = await getEndpointOr404(current.endpointId)
  const user = await requirePermission(event, 'server:manage', { serverId: ep.serverId })
  const input = await readValidated(event, watchtowerProfileInput)
  const p = await updateProfile(id, input)
  await audit({ actorUserId: user.id, actorLabel: user.email, action: 'watchtower.profile_updated', targetType: 'server_endpoint', targetId: ep.id, serverId: ep.serverId, outcome: 'success', ip: clientIp(event), details: { profile: id, ...input } })
  return profileDto(p)
})
