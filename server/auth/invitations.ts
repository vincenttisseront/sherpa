/** Invitations et réinitialisations : jeton envoyé une fois, seule son empreinte est conservée. */
import { randomBytes } from 'node:crypto'
import { and, eq, gt, isNull } from 'drizzle-orm'
import { db, schema } from '../db/client'
import { sha256Hex } from '../utils/crypto'
import { env } from '../utils/env'

export async function createInvitation(userId: string, purpose: 'invite' | 'reset', createdBy: string | null, validHours = purpose === 'reset' ? 2 : 72): Promise<{ url: string, expiresAt: Date }> {
  const token = randomBytes(32).toString('base64url')
  const expiresAt = new Date(Date.now() + validHours * 3600_000)
  // Un nouveau lien invalide les précédents de même nature.
  await db().update(schema.invitations).set({ usedAt: new Date() }).where(and(eq(schema.invitations.userId, userId), eq(schema.invitations.purpose, purpose), isNull(schema.invitations.usedAt)))
  await db().insert(schema.invitations).values({ userId, tokenHash: sha256Hex(token), purpose, expiresAt, createdBy })
  return { url: `${env().APP_URL}/invitation/${token}`, expiresAt }
}

export async function findValidInvitation(token: string) {
  const [r] = await db().select({ invitation: schema.invitations, user: schema.users }).from(schema.invitations)
    .innerJoin(schema.users, eq(schema.users.id, schema.invitations.userId))
    .where(and(eq(schema.invitations.tokenHash, sha256Hex(token)), isNull(schema.invitations.usedAt), gt(schema.invitations.expiresAt, new Date())))
  if (!r || r.user.kind === 'sso' || r.user.status === 'suspended') return null
  return r
}
