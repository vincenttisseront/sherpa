/**
 * Flux temps réel (Server-Sent Events). À la connexion, le client envoie le
 * dernier id reçu (Last-Event-ID ou ?afterId) : on renvoie d'abord le
 * rattrapage depuis la base, puis les nouvelles lignes publiées dans Redis.
 */
import { Redis } from 'ioredis'
import { z } from 'zod'
import { env } from '../../../../utils/env'
import { requirePermission } from '../../../../utils/auth'
import { idParam } from '../../../../utils/validation'
import { type LogLine, logChannel, queryLogs } from '../../../../services/logs'
import { deploymentScope } from '../../../../services/deployments'

defineRouteMeta({ openAPI: { tags: ['deployments'], summary: 'Flux SSE des logs d\'un déploiement (rattrapage puis temps réel)' } })

export default defineEventHandler(async (event) => {
  const { id } = await getValidatedRouterParams(event, idParam.parse)
  await requirePermission(event, 'logs:read', await deploymentScope(id))
  const { afterId } = await getValidatedQuery(event, z.object({ afterId: z.string().regex(/^\d+$/).optional() }).parse)
  let lastId = String(getHeader(event, 'last-event-id') ?? afterId ?? '0')
  if (!/^\d+$/.test(lastId)) lastId = '0'

  const stream = createEventStream(event)
  const sub = new Redis(env().REDIS_URL, { maxRetriesPerRequest: null })
  const pending: LogLine[] = []
  let caughtUp = false

  // Toutes les écritures passent par une file unique : ordre garanti, aucun saut d'id.
  let chain = Promise.resolve()
  const push = (lines: LogLine[]) => {
    chain = chain.then(async () => {
      for (const l of lines) {
        if (BigInt(l.id) <= BigInt(lastId)) continue
        lastId = l.id
        await stream.push({ id: l.id, event: 'log', data: JSON.stringify(l) })
      }
    })
    return chain
  }

  sub.on('message', (_ch, payload) => {
    const lines = JSON.parse(payload) as LogLine[]
    if (caughtUp) void push(lines)
    else pending.push(...lines)
  })
  await sub.subscribe(logChannel(id))

  const keepAlive = setInterval(() => void stream.push({ event: 'ping', data: '' }), 25_000)
  stream.onClosed(async () => {
    clearInterval(keepAlive)
    await sub.quit().catch(() => {})
    await stream.close()
  })

  // Le flux doit être renvoyé avant toute écriture (sinon push() attend un lecteur) :
  // rattrapage depuis la base en tâche de fond, puis vidage des lignes reçues entre-temps.
  void (async () => {
    for (;;) {
      const page = await queryLogs(id, { afterId: lastId, limit: 1000 })
      await push(page.lines)
      if (!page.hasMore) break
    }
    caughtUp = true
    await push(pending.sort((a, b) => (BigInt(a.id) < BigInt(b.id) ? -1 : 1)))
  })().catch(async () => {
    await stream.close()
  })

  return stream.send()
})
