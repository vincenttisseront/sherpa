import { channelInput } from '../../../../../shared/schemas/notifications'
import { db, schema } from '../../../../db/client'
import { audit } from '../../../../utils/audit'
import { clientIp, requirePermission } from '../../../../utils/auth'
import { readValidated, validationError } from '../../../../utils/validation'
import { checkChannelConfig, storeChannelConfig } from '../../../../services/notifications'

defineRouteMeta({ openAPI: { tags: ['notifications'], summary: 'Crée un canal de notification (email, Teams, Slack, Discord, ntfy, Gotify), immédiat ou en résumé périodique' } })

export default defineEventHandler(async (event) => {
  const user = await requirePermission(event, 'notification:manage')
  const input = await readValidated(event, channelInput)
  const errors = checkChannelConfig(input.kind, input.config)
  if (Object.keys(errors).length) throw validationError(errors)
  const configSecretId = await storeChannelConfig(input.kind, input.config)
  const [c] = await db().insert(schema.notificationChannels).values({ kind: input.kind, name: input.name, configSecretId, events: input.events, environmentIds: input.environmentIds, enabled: input.enabled, digest: input.digest, digestHour: input.digestHour, lastDigestAt: input.digest === 'off' ? null : new Date() }).returning()
  await audit({ actorUserId: user.id, actorLabel: user.email, action: 'notification.channel_create', targetType: 'notification_channel', targetId: c!.id, outcome: 'success', ip: clientIp(event), details: { name: input.name, kind: input.kind, events: input.events, digest: input.digest } })
  setResponseStatus(event, 201)
  return { id: c!.id }
})
