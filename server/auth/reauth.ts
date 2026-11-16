import { eq } from 'drizzle-orm'
import type { H3Event } from 'h3'
import { createError } from 'h3'
import { db, schema } from '../db/client'
import { requireUser } from '../utils/auth'
import { validationError } from '../utils/validation'
import { verifyPassword } from './password'
import { enforceRateLimit } from './rate-limit'

/** Compte local ou externe (pas SSO, pas jeton) qui confirme son mot de passe avant une opération sensible sur ses facteurs. */
export async function requireOwnPassword(event: H3Event, password: string) {
  const user = requireUser(event)
  if (!user.id || event.context.apiToken) throw createError({ statusCode: 403, statusMessage: 'Session utilisateur requise' })
  await enforceRateLimit(event, `reauth:${user.id}`, 8, 15 * 60, 'Trop de tentatives : patienter quelques minutes')
  const [u] = await db().select().from(schema.users).where(eq(schema.users.id, user.id))
  if (!u || u.kind === 'sso') throw createError({ statusCode: 409, statusMessage: 'Compte géré par votre fournisseur d\'identité : la double authentification s\'y configure' })
  if (!(await verifyPassword(u.passwordHash, password))) throw validationError({ password: 'Mot de passe incorrect' })
  return u
}

/** Comptes qui peuvent porter une double authentification locale. */
export function requireLocalAccount(event: H3Event) {
  const user = requireUser(event)
  if (!user.id || user.kind === 'sso' || user.kind === 'dev') throw createError({ statusCode: 409, statusMessage: 'Compte géré par votre fournisseur d\'identité : la double authentification s\'y configure' })
  return user as typeof user & { id: string }
}
