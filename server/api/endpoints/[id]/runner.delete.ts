import { eq } from 'drizzle-orm'
import { db, schema } from '../../../db/client'
import { audit } from '../../../utils/audit'
import { clientIp, requirePermission } from '../../../utils/auth'
import { idParam } from '../../../utils/validation'
import { getRunnerRow } from '../../../services/runner-admin'
import { getEndpointOr404 } from '../../../services/servers'

defineRouteMeta({ openAPI: { tags: ['runner'], summary: 'Retire le Runner de l\'endpoint (la clé HMAC est détruite)' } })

export default defineEventHandler(async (event) => {
  const { id } = await getValidatedRouterParams(event, idParam.parse)
  const ep = await getEndpointOr404(id)
  const user = await requirePermission(event, 'server:manage', { serverId: ep.serverId })
  const row = await getRunnerRow(id)
  if (!row) throw createError({ statusCode: 404, statusMessage: 'Aucun Runner configuré' })
  await db().transaction(async (tx) => {
    await tx.delete(schema.targetRunners).where(eq(schema.targetRunners.id, row.id))
    if (row.authSecretId) await tx.delete(schema.secrets).where(eq(schema.secrets.id, row.authSecretId))
  })
  await audit({ actorUserId: user.id, actorLabel: user.email, action: 'runner.delete', targetType: 'server_endpoint', targetId: id, serverId: ep.serverId, outcome: 'success', ip: clientIp(event), details: { url: row.url } })
  setResponseStatus(event, 204)
  return null
})
