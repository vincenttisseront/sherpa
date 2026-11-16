import { z } from 'zod'
import { findValidInvitation } from '../../../auth/invitations'

defineRouteMeta({ openAPI: { tags: ['auth'], summary: 'Informations d\'une invitation ou d\'une réinitialisation valide' } })

export default defineEventHandler(async (event) => {
  const { token } = await getValidatedRouterParams(event, z.object({ token: z.string().min(20).max(100) }).parse)
  const inv = await findValidInvitation(token)
  if (!inv) throw createError({ statusCode: 404, statusMessage: 'Lien invalide ou expiré' })
  return { email: inv.user.email, displayName: inv.user.displayName, purpose: inv.invitation.purpose }
})
