import { audit } from '../../../utils/audit'
import { clientIp, requirePermission } from '../../../utils/auth'
import { idParam } from '../../../utils/validation'
import { getEndpointOr404, portainerErrorMessage } from '../../../services/servers'
import { applyProfile, getProfileOr404, profileDto } from '../../../services/watchtower-profiles'

defineRouteMeta({ openAPI: { tags: ['watchtower'], summary: 'Déploie ou met à jour le conteneur Watchtower du profil sur l\'hôte' } })

export default defineEventHandler(async (event) => {
  const { id } = await getValidatedRouterParams(event, idParam.parse)
  const current = await getProfileOr404(id)
  const ep = await getEndpointOr404(current.endpointId)
  const user = await requirePermission(event, 'server:manage', { serverId: ep.serverId })
  try {
    const p = await applyProfile(id)
    await audit({ actorUserId: user.id, actorLabel: user.email, action: 'watchtower.profile_applied', targetType: 'server_endpoint', targetId: ep.id, serverId: ep.serverId, outcome: 'success', ip: clientIp(event), details: { profile: id } })
    return profileDto(p)
  }
  catch (err) {
    throw createError({ statusCode: 502, statusMessage: `Application du profil impossible : ${portainerErrorMessage(err)}` })
  }
})
