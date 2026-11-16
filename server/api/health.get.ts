import { sql } from 'drizzle-orm'
import { db } from '../db/client'
import { redis } from '../queue/redis'
import { WORKER_HEARTBEAT_KEY } from '../queue/queues'

defineRouteMeta({
  openAPI: { tags: ['system'], summary: 'État de santé : base et Redis (code HTTP), présence du worker' },
})

export default defineEventHandler(async (event) => {
  const check = async (fn: () => Promise<unknown>) => {
    try {
      await fn()
      return 'ok' as const
    }
    catch {
      return 'error' as const
    }
  }
  const [database, cache] = await Promise.all([
    check(() => db().execute(sql`select 1`)),
    check(() => redis().ping()),
  ])
  const beat = cache === 'ok' ? await redis().get(WORKER_HEARTBEAT_KEY).catch(() => null) : null
  // Le worker n'entre pas dans le code HTTP : redémarrer l'application ne le relancerait pas.
  const worker = beat ? 'ok' as const : 'absent' as const
  const ok = database === 'ok' && cache === 'ok'
  setResponseStatus(event, ok ? 200 : 503)
  return { status: ok ? (worker === 'ok' ? 'ok' : 'degraded') : 'error', database, redis: cache, worker }
})
