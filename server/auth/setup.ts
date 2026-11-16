/**
 * Initialisation : tant qu'aucun compte n'existe, un jeton à usage unique est
 * généré et affiché une seule fois dans les logs du serveur. Seul quelqu'un
 * ayant accès à ces logs peut créer le premier administrateur.
 */
import { randomBytes } from 'node:crypto'
import { count } from 'drizzle-orm'
import { db, schema } from '../db/client'
import { redis } from '../queue/redis'
import { safeEqual, sha256Hex } from '../utils/crypto'

const KEY = 'setup:token'

export async function setupRequired(): Promise<boolean> {
  const [{ n }] = await db().select({ n: count() }).from(schema.users) as [{ n: number }]
  return n === 0
}

/** Émet un jeton s'il n'en existe pas ; renvoie le jeton en clair uniquement à l'émission. */
export async function issueSetupToken(force = false): Promise<string | null> {
  if (!(await setupRequired())) return null
  const token = randomBytes(18).toString('base64url')
  const ok = force
    ? await redis().set(KEY, sha256Hex(token), 'EX', 24 * 3600)
    : await redis().set(KEY, sha256Hex(token), 'EX', 24 * 3600, 'NX')
  return ok === 'OK' ? token : null
}

export async function consumeSetupToken(token: string): Promise<boolean> {
  const stored = await redis().get(KEY)
  if (!stored || !safeEqual(stored, sha256Hex(token))) return false
  return (await redis().del(KEY)) === 1
}
