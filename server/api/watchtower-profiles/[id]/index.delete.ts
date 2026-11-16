import { audit } from '../../../utils/audit'
import { clientIp, requirePermission } from '../../../utils/auth'
import { idParam } from '../../../utils/validation'
import { getEndpointOr404 } from '../../../services/servers'
import { deleteProfile, getProfileOr404 } from '../../../services/watchtower-profiles'

defineRouteMeta({ openAPI: { tags: ['watchtower'], summary: 'Supprime un profil Watchtower inutilisé (et son conteneur)' } })

export default defineEventHandler(async (event) => {
  const { id } = await getValidatedRouterParams(event, idParam.parse)
  const p = await getProfileOr404(id)
  const ep = await getEndpointOr404(p.endpointId)
  const user = await requirePermission(event, 'server:manage', { serverId: ep.serverId })
  await deleteProfile(id)
  await audit({ actorUserId: user.id, actorLabel: user.email, action: 'watchtower.profile_deleted', targetType: 'server_endpoint', targetId: ep.id, serverId: ep.serverId, outcome: 'success', ip: clientIp(event), details: { profile: id, name: p.name } })
  setResponseStatus(event, 204)
  return null
})
