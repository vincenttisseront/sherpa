import { listApiTokens } from '../../auth/api-tokens'
import { requireUser } from '../../utils/auth'

defineRouteMeta({ openAPI: { tags: ['account'], summary: 'Jetons d\'API de l\'utilisateur connecté (le jeton lui-même n\'est jamais renvoyé)' } })

export default defineEventHandler(async (event) => {
  const user = requireUser(event)
  if (!user.id) return []
  return listApiTokens(user.id)
})
