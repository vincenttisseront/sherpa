/** Limitation de débit (§19) : fenêtre fixe dans Redis, partagée entre instances. */
import type { H3Event } from 'h3'
import { createError, setResponseHeader } from 'h3'
import { redis } from '../queue/redis'

export async function hit(key: string, limit: number, windowSec: number): Promise<{ allowed: boolean, retryAfter: number, count: number }> {
  const k = `rl:${key}:${Math.floor(Date.now() / 1000 / windowSec)}`
  const [[, count]] = await redis().multi().incr(k).expire(k, windowSec + 1).exec() as [[null, number], [null, number]]
  return { allowed: count <= limit, retryAfter: windowSec - (Math.floor(Date.now() / 1000) % windowSec), count }
}

export async function enforceRateLimit(event: H3Event, key: string, limit: number, windowSec: number, message = 'Trop de requêtes : réessayer dans quelques instants') {
  const r = await hit(key, limit, windowSec)
  if (!r.allowed) {
    setResponseHeader(event, 'Retry-After', r.retryAfter)
    throw createError({ statusCode: 429, statusMessage: message })
  }
}
