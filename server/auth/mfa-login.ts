/** Fin de connexion commune (second facteur ou passkey) : vérifie l'état du compte, ouvre la session, journalise. */
import { eq } from 'drizzle-orm'
import type { H3Event } from 'h3'
import { createError } from 'h3'
import { db, schema } from '../db/client'
import { audit } from '../utils/audit'
import { clientIp } from '../utils/auth'
import { createSession } from './sessions'

export async function completeLogin(event: H3Event, userId: string, method: 'totp' | 'recovery' | 'passkey', extra: Record<string, unknown> = {}) {
  const [user] = await db().select().from(schema.users).where(eq(schema.users.id, userId))
  const refuse = async (reason: string, msg: string) => {
    await audit({ actorUserId: user?.id ?? null, actorLabel: user?.email ?? 'inconnu', action: 'auth.login', outcome: 'denied', ip: clientIp(event), details: { method, reason } })
    throw createError({ statusCode: 403, statusMessage: msg })
  }
  if (!user || user.kind === 'sso') return refuse('unknown', 'Connexion refusée')
  if (user.lockedUntil && user.lockedUntil.getTime() > Date.now()) return refuse('locked', 'Compte temporairement verrouillé après plusieurs échecs : réessayer plus tard')
  if (user.status !== 'active') return refuse(user.status, user.status === 'invited' ? 'Invitation non encore acceptée' : 'Compte suspendu : contacter un administrateur')
  if (user.expiresAt && user.expiresAt.getTime() <= Date.now()) return refuse('expired', 'Compte expiré : contacter un administrateur')
  await db().update(schema.users).set({ failedLoginCount: 0, lockedUntil: null, lastLoginAt: new Date() }).where(eq(schema.users.id, user.id))
  const { csrfToken } = await createSession(event, user.id, null, method)
  await audit({ actorUserId: user.id, actorLabel: user.email, action: 'auth.login', outcome: 'success', ip: clientIp(event), details: { method, kind: user.kind, ...extra } })
  return { ok: true as const, csrfToken }
}
