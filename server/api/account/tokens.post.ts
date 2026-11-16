import { apiTokenInput } from '../../../shared/schemas/api-tokens'
import { createApiToken } from '../../auth/api-tokens'
import { audit } from '../../utils/audit'
import { clientIp, requireUser } from '../../utils/auth'
import { readValidated } from '../../utils/validation'

defineRouteMeta({ openAPI: { tags: ['account'], summary: 'Crée un jeton d\'API (profil, portée, durée de validité) : renvoyé UNE fois' } })

export default defineEventHandler(async (event) => {
  const user = requireUser(event)
  if (!user.id) throw createError({ statusCode: 403, statusMessage: 'Compte requis pour créer un jeton' })
  const input = await readValidated(event, apiTokenInput)
  const { token, dto } = await createApiToken(user.id, input)
  await audit({ actorUserId: user.id, actorLabel: user.email, action: 'apitoken.created', targetType: 'user', targetId: user.id, projectId: input.projectId, environmentId: input.environmentId, outcome: 'success', ip: clientIp(event), details: { name: input.name, preset: input.preset, expiresAt: dto.expiresAt } })
  setResponseStatus(event, 201)
  return { token, ...dto }
})
