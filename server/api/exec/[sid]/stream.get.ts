import { z } from 'zod'
import { getExec, replay, subscribe } from '../../../services/exec'
import { requireUser } from '../../../utils/auth'

defineRouteMeta({ openAPI: { tags: ['live'], summary: 'Sortie d\'un terminal de conteneur (SSE : data en base64, exit) ; reprise possible avec Last-Event-ID' } })

export default defineEventHandler(async (event) => {
  const user = requireUser(event)
  const { sid } = await getValidatedRouterParams(event, z.object({ sid: z.string().min(10).max(40) }).parse)
  const s = user.id && !event.context.apiToken ? getExec(sid, user.id) : null
  if (!s) throw createError({ statusCode: 404, statusMessage: 'Terminal introuvable ou terminé' })
  const last = Number.parseInt(getRequestHeader(event, 'last-event-id') ?? '0', 10)

  const stream = createEventStream(event)
  const send = (offset: number, data: Buffer) => stream.push({ id: String(offset + data.length), event: 'data', data: data.toString('base64') })
  let unsubscribe = () => {}
  const finish = async (reason: string) => {
    unsubscribe()
    await stream.push({ event: 'exit', data: reason })
    await stream.close()
  }
  // File d'envoi unique : l'ordre des octets est conservé même si plusieurs morceaux arrivent d'un coup.
  let chain: Promise<unknown> = Promise.resolve()
  const enqueue = (fn: () => Promise<unknown>) => { chain = chain.then(fn).catch(() => undefined) }

  // Les en-têtes partent aussitôt : sans sortie du shell, le navigateur croirait la connexion en attente.
  enqueue(() => stream.push({ event: 'ready', data: String(s.total) }))
  const backlog = replay(s, Number.isFinite(last) && last > 0 ? last : 0)
  if (backlog) enqueue(() => send(backlog.offset, backlog.data))
  unsubscribe = subscribe(s, (e) => {
    if (e.type === 'data') enqueue(() => send(e.offset, e.data))
    else enqueue(() => finish(e.reason))
  })
  if (s.closed) enqueue(() => finish(s.closed!))
  stream.onClosed(() => unsubscribe())
  return stream.send()
})
