/**
 * Livraison d'un webhook GitHub (push, release, ping). Route publique : authentifiée par la
 * signature HMAC-SHA256 du corps (secret propre au projet), comparée à temps constant.
 */
import { handleDelivery } from '../../../services/webhooks'

defineRouteMeta({ openAPI: { tags: ['webhooks'], summary: 'Webhook GitHub d\'un projet : déploie les environnements qui suivent la branche poussée (signature X-Hub-Signature-256)' } })

const MAX_BODY = 1024 * 1024

export default defineEventHandler(async (event) => {
  const projectId = event.context.params?.projectId ?? ''
  if (!/^[0-9a-f-]{36}$/i.test(projectId)) throw createError({ statusCode: 404, statusMessage: 'Introuvable' })
  const raw = (await readRawBody(event, 'utf8').catch(() => '')) ?? ''
  if (raw.length > MAX_BODY) throw createError({ statusCode: 413, statusMessage: 'Charge utile trop volumineuse' })
  const r = await handleDelivery(projectId, { guid: getHeader(event, 'x-github-delivery') ?? '', event: getHeader(event, 'x-github-event') ?? '', signature: getHeader(event, 'x-hub-signature-256'), raw })
  setResponseStatus(event, r.status)
  return r.body
})
