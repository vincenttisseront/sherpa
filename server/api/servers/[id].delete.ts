import { eq, inArray } from 'drizzle-orm'
import { db, schema } from '../../db/client'
import { audit } from '../../utils/audit'
import { clientIp, requirePermission } from '../../utils/auth'
import { idParam } from '../../utils/validation'
import { getServerOr404 } from '../../services/servers'

defineRouteMeta({ openAPI: { tags: ['servers'], summary: 'Supprime un serveur (refusé s\'il porte des projets)' } })

export default defineEventHandler(async (event) => {
  const { id } = await getValidatedRouterParams(event, idParam.parse)
  const user = await requirePermission(event, 'server:manage', { serverId: id })
  const server = await getServerOr404(id)

  const endpointIds = (await db().select({ id: schema.serverEndpoints.id }).from(schema.serverEndpoints).where(eq(schema.serverEndpoints.serverId, id))).map(e => e.id)
  if (endpointIds.length) {
    const used = await db().$count(schema.projectTargets, inArray(schema.projectTargets.endpointId, endpointIds))
    if (used > 0) throw createError({ statusCode: 409, statusMessage: `${used} cible(s) de déploiement utilisent ce serveur : les retirer d'abord` })
  }

  await db().transaction(async (tx) => {
    await tx.delete(schema.portainerServers).where(eq(schema.portainerServers.id, id))
    // Le token chiffré disparaît avec le serveur.
    await tx.delete(schema.secrets).where(eq(schema.secrets.id, server.tokenSecretId))
  })

  await audit({
    actorUserId: user.id, actorLabel: user.email, action: 'server.delete', targetType: 'portainer_server', targetId: id,
    outcome: 'success', ip: clientIp(event), details: { name: server.name, url: server.url },
  })
  setResponseStatus(event, 204)
  return null
})
