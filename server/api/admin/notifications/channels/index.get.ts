import { requirePermission } from '../../../../utils/auth'
import { smtpConfigured } from '../../../../adapters/notifications/email'
import { listChannels } from '../../../../services/notifications'
import { env } from '../../../../utils/env'

defineRouteMeta({ openAPI: { tags: ['notifications'], summary: 'Canaux de notification (configuration secrète jamais renvoyée)' } })

export default defineEventHandler(async (event) => {
  await requirePermission(event, 'notification:manage')
  return { channels: await listChannels(), smtp: smtpConfigured(), webhookHosts: env().NOTIFY_WEBHOOK_ALLOWED_HOSTS.split(',').map(h => h.trim()).filter(Boolean) }
})
