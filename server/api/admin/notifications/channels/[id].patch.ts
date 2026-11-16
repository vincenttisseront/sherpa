import { eq } from 'drizzle-orm'
import { channelPatch } from '../../../../../shared/schemas/notifications'
import { db, schema } from '../../../../db/client'
import { audit } from '../../../../utils/audit'
import { clientIp, requirePermission } from '../../../../utils/auth'
import { idParam, readValidated, validationError } from '../../../../utils/validation'
import { checkChannelConfig, storeChannelConfig } from '../../../../services/notifications'

defineRouteMeta({ openAPI: { tags: ['notifications'], summary: 'Modifie un canal ; la configuration n\'est remplacée que si elle est fournie' } })

export default defineEventHandler(async (event) => {
  const user = await requirePermission(event, 'notification:manage')
  const { id } = await getValidatedRouterParams(event, idParam.parse)
  const [c] = await db().select().from(schema.notificationChannels).where(eq(schema.notificationChannels.id, id))
  if (!c) throw createError({ statusCode: 404, statusMessage: 'Canal introuvable' })
  const { config, ...patch } = await readValidated(event, channelPatch)
  if (config !== undefined) {
    const errors = checkChannelConfig(c.kind, config)
    if (Object.keys(errors).length) throw validationError(errors)
    await storeChannelConfig(c.kind, config, c.configSecretId)
  }
  // Passage en mode résumé : le premier résumé couvre ce qui suit ce changement.
  const startsDigest = patch.digest !== undefined && patch.digest !== 'off' && c.digest === 'off'
  await db().update(schema.notificationChannels).set({ ...patch, ...(startsDigest ? { lastDigestAt: new Date() } : {}) }).where(eq(schema.notificationChannels.id, id))
  await audit({ actorUserId: user.id, actorLabel: user.email, action: 'notification.channel_update', targetType: 'notification_channel', targetId: id, outcome: 'success', ip: clientIp(event), details: { ...patch, configReplaced: config !== undefined } })
  return { ok: true }
})
