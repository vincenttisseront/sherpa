import { eq } from 'drizzle-orm'
import { z } from 'zod'
import { findValidInvitation } from '../../../auth/invitations'
import { checkPasswordPolicy, hashPassword } from '../../../auth/password'
import { enforceRateLimit } from '../../../auth/rate-limit'
import { createSession, revokeUserSessions } from '../../../auth/sessions'
import { db, schema } from '../../../db/client'
import { audit } from '../../../utils/audit'
import { clientIp } from '../../../utils/auth'
import { readValidated, validationError } from '../../../utils/validation'

defineRouteMeta({ openAPI: { tags: ['auth'], summary: 'Accepte une invitation ou une réinitialisation : définit le mot de passe' } })

export default defineEventHandler(async (event) => {
  await enforceRateLimit(event, `invite:${clientIp(event)}`, 10, 15 * 60)
  const { token } = await getValidatedRouterParams(event, z.object({ token: z.string().min(20).max(100) }).parse)
  const { password } = await readValidated(event, z.object({ password: z.string().max(256) }))
  const inv = await findValidInvitation(token)
  if (!inv) throw createError({ statusCode: 404, statusMessage: 'Lien invalide ou expiré' })
  const policy = checkPasswordPolicy(password, inv.user.email)
  if (policy) throw validationError({ password: policy })
  await db().transaction(async (tx) => {
    await tx.update(schema.users).set({ passwordHash: await hashPassword(password), passwordChangedAt: new Date(), status: inv.user.status === 'invited' ? 'active' : inv.user.status, failedLoginCount: 0, lockedUntil: null }).where(eq(schema.users.id, inv.user.id))
    await tx.update(schema.invitations).set({ usedAt: new Date() }).where(eq(schema.invitations.id, inv.invitation.id))
  })
  // Une réinitialisation coupe toutes les sessions existantes.
  await revokeUserSessions(inv.user.id)
  if (inv.user.status === 'invited' || inv.user.status === 'active') await createSession(event, inv.user.id)
  await audit({ actorUserId: inv.user.id, actorLabel: inv.user.email, action: `auth.${inv.invitation.purpose === 'reset' ? 'password_reset' : 'invitation_accepted'}`, outcome: 'success', ip: clientIp(event) })
  return { ok: true }
})
