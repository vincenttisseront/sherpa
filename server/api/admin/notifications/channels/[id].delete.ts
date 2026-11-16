import { eq } from 'drizzle-orm'
import { db, schema } from '../../../../db/client'
import { audit } from '../../../../utils/audit'
import { clientIp, requirePermission } from '../../../../utils/auth'
import { idParam } from '../../../../utils/validation'

defineRouteMeta({ openAPI: { tags: ['notifications'], summary: 'Supprime un canal et sa configuration chiffrée (l\'historique des envois est conservé)' } })

export default defineEventHandler(async (event) => {
  const user = await requirePermission(event, 'notification:manage')
  const { id } = await getValidatedRouterParams(event, idParam.parse)
  const [c] = await db().select().from(schema.notificationChannels).where(eq(schema.notificationChannels.id, id))
  if (!c) throw createError({ statusCode: 404, statusMessage: 'Canal introuvable' })
  await db().transaction(async (tx) => {
    await tx.delete(schema.notificationChannels).where(eq(schema.notificationChannels.id, id))
    await tx.delete(schema.secrets).where(eq(schema.secrets.id, c.configSecretId))
  })
  await audit({ actorUserId: user.id, actorLabel: user.email, action: 'notification.channel_delete', targetType: 'notification_channel', targetId: id, outcome: 'success', ip: clientIp(event), details: { name: c.name, kind: c.kind } })
  setResponseStatus(event, 204)
  return null
})
