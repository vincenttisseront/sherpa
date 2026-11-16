/**
 * Notification de fin de passage envoyée par Watchtower (Shoutrrr « generic »).
 * Route publique : authentifiée par le jeton propre à la cible, comparé à temps constant.
 * Le traitement (appels à l'agent) est confié au worker.
 */
import { maintenanceQueue } from '../../../../queue/queues'
import { parseReport, verifyHookToken } from '../../../../services/watchtower'

defineRouteMeta({ openAPI: { tags: ['watchtower'], summary: 'Rapport de passage Watchtower (jeton de cible)' } })

const MAX_BODY = 256 * 1024

export default defineEventHandler(async (event) => {
  const { targetId = '', token = '' } = event.context.params ?? {}
  const target = await verifyHookToken(targetId, token)
  if (!target) throw createError({ statusCode: 404, statusMessage: 'Introuvable' })
  const raw = (await readRawBody(event, 'utf8').catch(() => '')) ?? ''
  if (raw.length > MAX_BODY) throw createError({ statusCode: 413, statusMessage: 'Rapport trop volumineux' })
  const report = parseReport(raw)
  await maintenanceQueue().add('watchtower-report', { targetId: target.id, report }, { removeOnComplete: 200, removeOnFail: 500 })
  setResponseStatus(event, 202)
  return { accepted: true }
})
