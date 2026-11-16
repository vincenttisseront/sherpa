/**
 * Sessions côté serveur (§15, §19). Le cookie porte un jeton aléatoire ; la
 * base n'en conserve que l'empreinte SHA-256. Expiration d'inactivité et
 * durée maximale, révocation immédiate, jeton CSRF propre à chaque session.
 */
import { randomBytes } from 'node:crypto'
import { and, eq, isNull, ne } from 'drizzle-orm'
import type { H3Event } from 'h3'
import { deleteCookie, getCookie, getRequestHeader, setCookie } from 'h3'
import { db, schema } from '../db/client'
import { sha256Hex } from '../utils/crypto'
import { env } from '../utils/env'
import { closeUserExecs } from '../services/exec'
import { refreshMfaPending } from './mfa'

export const SESSION_COOKIE = 'pp_session'
const TOUCH_EVERY_MS = 60_000

export interface ResolvedSession {
  id: string
  csrfToken: string
  idpId: string | null
  /** Double authentification exigée mais non configurée : l'API se limite à la configuration du compte. */
  mfaPending: boolean
  user: typeof schema.users.$inferSelect
}

function clientIp(event: H3Event): string | null {
  return event.node.req.socket.remoteAddress ?? null
}

/** `mfaMethod` : facteur prouvé à l'ouverture (password, totp, recovery, passkey). */
export async function createSession(event: H3Event, userId: string, idpId: string | null = null, mfaMethod: string | null = null): Promise<{ csrfToken: string }> {
  const e = env()
  const token = randomBytes(32).toString('base64url')
  const csrfToken = randomBytes(24).toString('base64url')
  const now = Date.now()
  await db().insert(schema.sessions).values({
    id: sha256Hex(token),
    userId,
    idpId,
    ip: clientIp(event),
    userAgent: (getRequestHeader(event, 'user-agent') ?? '').slice(0, 300),
    csrfToken,
    mfaMethod: mfaMethod ?? (idpId ? 'sso' : 'password'),
    expiresAt: new Date(now + e.SESSION_MAX_HOURS * 3600_000),
  })
  // La politique peut exiger un second facteur que le compte n'a pas encore : la session est alors limitée au compte.
  await refreshMfaPending(userId)
  setCookie(event, SESSION_COOKIE, token, {
    httpOnly: true,
    secure: e.COOKIE_SECURE,
    // Lax : le cookie accompagne le retour OIDC (navigation GET) mais pas les POST intersites.
    sameSite: 'lax',
    path: '/',
    maxAge: e.SESSION_MAX_HOURS * 3600,
  })
  return { csrfToken }
}

export function clearSessionCookie(event: H3Event) {
  deleteCookie(event, SESSION_COOKIE, { path: '/' })
}

export async function resolveSession(event: H3Event): Promise<ResolvedSession | null> {
  const token = getCookie(event, SESSION_COOKIE)
  if (!token || token.length > 100) return null
  const id = sha256Hex(token)
  const [row] = await db().select({ s: schema.sessions, u: schema.users }).from(schema.sessions)
    .innerJoin(schema.users, eq(schema.users.id, schema.sessions.userId))
    .where(and(eq(schema.sessions.id, id), isNull(schema.sessions.revokedAt)))
  const now = Date.now()
  const idleMs = env().SESSION_IDLE_MIN * 60_000
  const invalid = !row
    || row.s.expiresAt.getTime() <= now
    || row.s.lastSeenAt.getTime() + idleMs <= now
    || row.u.status !== 'active'
    || (row.u.expiresAt !== null && row.u.expiresAt.getTime() <= now)
  if (invalid) {
    if (row) await db().update(schema.sessions).set({ revokedAt: new Date() }).where(eq(schema.sessions.id, id))
    clearSessionCookie(event)
    return null
  }
  if (now - row.s.lastSeenAt.getTime() > TOUCH_EVERY_MS) {
    await db().update(schema.sessions).set({ lastSeenAt: new Date(now) }).where(eq(schema.sessions.id, id))
  }
  return { id, csrfToken: row.s.csrfToken, idpId: row.s.idpId, mfaPending: row.s.mfaPending, user: row.u }
}

export async function revokeSession(id: string): Promise<void> {
  await db().update(schema.sessions).set({ revokedAt: new Date() }).where(eq(schema.sessions.id, id))
}

/** Révoque toutes les sessions d'un utilisateur (suspension, changement de mot de passe…). */
export async function revokeUserSessions(userId: string, exceptId?: string): Promise<number> {
  const rows = await db().update(schema.sessions).set({ revokedAt: new Date() })
    .where(and(eq(schema.sessions.userId, userId), isNull(schema.sessions.revokedAt), ...(exceptId ? [ne(schema.sessions.id, exceptId)] : [])))
    .returning({ id: schema.sessions.id })
  // Les terminaux de conteneur ouverts par cette personne ne lui survivent pas.
  if (rows.length) await closeUserExecs(userId, 'sessions révoquées')
  return rows.length
}
