/**
 * Notification de fin de passage du Watchtower d'un profil (Shoutrrr « generic »).
 * Route publique : authentifiée par le jeton propre au profil, comparé à temps constant.
 * Le rapport est réparti entre les projets du profil par le worker.
 */
import { maintenanceQueue } from '../../../../queue/queues'
import { parseReport } from '../../../../services/watchtower'
import { verifyProfileHook } from '../../../../services/watchtower-profiles'

defineRouteMeta({ openAPI: { tags: ['watchtower'], summary: 'Rapport de passage du Watchtower d\'un profil (jeton du profil)' } })

const MAX_BODY = 256 * 1024

export default defineEventHandler(async (event) => {
  const { profileId = '', token = '' } = event.context.params ?? {}
  const profile = await verifyProfileHook(profileId, token)
  if (!profile) throw createError({ statusCode: 404, statusMessage: 'Introuvable' })
  const raw = (await readRawBody(event, 'utf8').catch(() => '')) ?? ''
  if (raw.length > MAX_BODY) throw createError({ statusCode: 413, statusMessage: 'Rapport trop volumineux' })
  await maintenanceQueue().add('watchtower-profile-report', { profileId: profile.id, report: parseReport(raw) }, { removeOnComplete: 200, removeOnFail: 500 })
  setResponseStatus(event, 202)
  return { accepted: true }
})
