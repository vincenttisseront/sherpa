import { eq, sql } from 'drizzle-orm'
import { z } from 'zod'
import { verifyPassword } from '../../auth/password'
import { enforceRateLimit } from '../../auth/rate-limit'
import { createLoginChallenge, hasMfa, mfaStatus } from '../../auth/mfa'
import { createSession } from '../../auth/sessions'
import { db, schema } from '../../db/client'
import { audit } from '../../utils/audit'
import { clientIp } from '../../utils/auth'
import { env } from '../../utils/env'
import { readValidated } from '../../utils/validation'

defineRouteMeta({ openAPI: { tags: ['auth'], summary: 'Connexion par compte local ou externe (Argon2id, verrouillage après échecs)' } })

const body = z.object({ email: z.string().trim().toLowerCase().max(254), password: z.string().min(1).max(256) })
const GENERIC = 'Email ou mot de passe incorrect'

export default defineEventHandler(async (event) => {
  const ip = clientIp(event) ?? 'inconnue'
  await enforceRateLimit(event, `login-ip:${ip}`, 20, 60, 'Trop de tentatives de connexion : patienter une minute')
  const { email, password } = await readValidated(event, body)
  await enforceRateLimit(event, `login-email:${email}`, 10, 15 * 60, 'Trop de tentatives pour ce compte : patienter quelques minutes')

  const [user] = await db().select().from(schema.users).where(sql`lower(${schema.users.email}) = ${email}`)
  const fail = async (reason: string, status = 401, message = GENERIC) => {
    await audit({ actorUserId: user?.id ?? null, actorLabel: email, action: 'auth.login', outcome: 'failure', ip, details: { method: 'password', reason } })
    throw createError({ statusCode: status, statusMessage: message })
  }

  // Le hash est vérifié même sans compte (temps constant, pas d'énumération).
  const valid = await verifyPassword(user && user.kind !== 'sso' ? user.passwordHash : null, password)
  if (!user || user.kind === 'sso') return fail(user ? 'sso_account' : 'unknown')
  if (user.lockedUntil && user.lockedUntil.getTime() > Date.now()) return fail('locked', 423, 'Compte temporairement verrouillé après plusieurs échecs : réessayer plus tard')
  if (!valid) {
    const e = env()
    const failures = user.failedLoginCount + 1
    const lock = failures >= e.LOGIN_MAX_FAILURES
    await db().update(schema.users).set(lock ? { failedLoginCount: 0, lockedUntil: new Date(Date.now() + e.LOGIN_LOCK_MIN * 60_000) } : { failedLoginCount: failures }).where(eq(schema.users.id, user.id))
    if (lock) await audit({ actorUserId: user.id, actorLabel: email, action: 'auth.lockout', outcome: 'denied', ip, details: { minutes: e.LOGIN_LOCK_MIN } })
    return fail('bad_password')
  }
  // Mot de passe prouvé : on peut donner la raison exacte.
  if (user.status === 'invited') return fail('invited', 403, 'Invitation non encore acceptée')
  if (user.status !== 'active') return fail(user.status, 403, 'Compte suspendu : contacter un administrateur')
  if (user.expiresAt && user.expiresAt.getTime() <= Date.now()) return fail('expired', 403, 'Compte expiré : contacter un administrateur')

  await db().update(schema.users).set({ failedLoginCount: 0, lockedUntil: null }).where(eq(schema.users.id, user.id))
  // Second facteur enrôlé : pas de session avant sa vérification (défi de 5 minutes, 5 essais).
  const mfa = await mfaStatus(user.id)
  if (hasMfa(mfa)) {
    const mfaToken = await createLoginChallenge(user.id)
    return { ok: false, mfaRequired: true, mfaToken, methods: { totp: mfa.totp, passkey: mfa.passkeys.length > 0, recovery: mfa.recoveryCodesLeft > 0 } }
  }
  await db().update(schema.users).set({ lastLoginAt: new Date() }).where(eq(schema.users.id, user.id))
  const { csrfToken } = await createSession(event, user.id)
  await audit({ actorUserId: user.id, actorLabel: user.email, action: 'auth.login', outcome: 'success', ip, details: { method: 'password', kind: user.kind } })
  return { ok: true, csrfToken }
})
