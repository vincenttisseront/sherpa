import { eq } from 'drizzle-orm'
import { z } from 'zod'
import { checkPasswordPolicy, hashPassword, verifyPassword } from '../../auth/password'
import { enforceRateLimit } from '../../auth/rate-limit'
import { revokeUserSessions } from '../../auth/sessions'
import { db, schema } from '../../db/client'
import { audit } from '../../utils/audit'
import { clientIp, requireUser } from '../../utils/auth'
import { readValidated, validationError } from '../../utils/validation'

defineRouteMeta({ openAPI: { tags: ['account'], summary: 'Change mon mot de passe (comptes locaux et externes) ; mes autres sessions sont révoquées' } })

export default defineEventHandler(async (event) => {
  const user = requireUser(event)
  await enforceRateLimit(event, `pwd:${user.id}`, 5, 15 * 60)
  const { current, next } = await readValidated(event, z.object({ current: z.string().max(256), next: z.string().max(256) }))
  const [u] = await db().select().from(schema.users).where(eq(schema.users.id, user.id ?? ''))
  if (!u || u.kind === 'sso') throw createError({ statusCode: 409, statusMessage: 'Mot de passe géré par votre fournisseur d\'identité' })
  if (!(await verifyPassword(u.passwordHash, current))) throw validationError({ current: 'Mot de passe actuel incorrect' })
  const policy = checkPasswordPolicy(next, u.email)
  if (policy) throw validationError({ next: policy })
  await db().update(schema.users).set({ passwordHash: await hashPassword(next), passwordChangedAt: new Date() }).where(eq(schema.users.id, u.id))
  const revoked = await revokeUserSessions(u.id, event.context.session?.id)
  await audit({ actorUserId: u.id, actorLabel: u.email, action: 'account.password_change', outcome: 'success', ip: clientIp(event), details: { revokedSessions: revoked } })
  return { ok: true, revokedSessions: revoked }
})
