import { revokeApiToken } from '../../../auth/api-tokens'
import { audit } from '../../../utils/audit'
import { clientIp, requireUser } from '../../../utils/auth'
import { idParam } from '../../../utils/validation'

defineRouteMeta({ openAPI: { tags: ['account'], summary: 'Révoque un jeton d\'API de l\'utilisateur connecté (immédiat)' } })

export default defineEventHandler(async (event) => {
  const { id } = await getValidatedRouterParams(event, idParam.parse)
  const user = requireUser(event)
  const name = user.id ? await revokeApiToken(user.id, id) : null
  if (!name) throw createError({ statusCode: 404, statusMessage: 'Jeton introuvable ou déjà révoqué' })
  await audit({ actorUserId: user.id, actorLabel: user.email, action: 'apitoken.revoked', targetType: 'user', targetId: user.id ?? undefined, outcome: 'success', ip: clientIp(event), details: { name } })
  return { revoked: true }
})
