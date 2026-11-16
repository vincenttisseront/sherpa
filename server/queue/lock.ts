/**
 * Verrou distribué simple (une seule instance Redis) : un seul job actif
 * par couple projet/environnement (§13). Libération conditionnée au jeton
 * pour ne jamais lever le verrou d'un autre détenteur.
 */
import { randomUUID } from 'node:crypto'
import type { Redis } from 'ioredis'

const RELEASE = `if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) else return 0 end`
const EXTEND = `if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('pexpire', KEYS[1], ARGV[2]) else return 0 end`

export interface Lock {
  key: string
  token: string
  extend(ttlMs: number): Promise<boolean>
  release(): Promise<void>
}

export function deploymentLockKey(projectId: string, environmentId: string): string {
  return `lock:deploy:${projectId}:${environmentId}`
}

export async function acquireLock(redis: Redis, key: string, ttlMs: number): Promise<Lock | null> {
  const token = randomUUID()
  const ok = await redis.set(key, token, 'PX', ttlMs, 'NX')
  if (ok !== 'OK') return null
  return {
    key,
    token,
    extend: async (ms: number) => (await redis.eval(EXTEND, 1, key, token, String(ms))) === 1,
    release: async () => {
      await redis.eval(RELEASE, 1, key, token)
    },
  }
}
