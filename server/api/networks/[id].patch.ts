import { and, eq, isNull } from 'drizzle-orm'
import { networkPatch } from '../../../shared/schemas/infra'
import { db, schema } from '../../db/client'
import { audit } from '../../utils/audit'
import { clientIp, requirePermission } from '../../utils/auth'
import { idParam, readValidated, validationError } from '../../utils/validation'
import { environmentMaps, getEndpointOr404 } from '../../services/servers'

defineRouteMeta({ openAPI: { tags: ['networks'], summary: 'Politique d\'un réseau : autorisé/interdit, rôle, environnements, description' } })

export default defineEventHandler(async (event) => {
  const { id } = await getValidatedRouterParams(event, idParam.parse)
  const [net] = await db().select().from(schema.networks).where(eq(schema.networks.id, id))
  if (!net) throw createError({ statusCode: 404, statusMessage: 'Réseau introuvable' })
  const ep = await getEndpointOr404(net.endpointId)
  const user = await requirePermission(event, 'network:manage', { serverId: ep.serverId })
  const patch = await readValidated(event, networkPatch)

  // Ne pas retirer l'autorisation du réseau utilisé par Traefik.
  if (patch.policy && patch.policy !== 'allowed') {
    const usedByTraefik = await db().$count(schema.traefikConfigs, and(eq(schema.traefikConfigs.endpointId, net.endpointId), eq(schema.traefikConfigs.networkName, net.name), isNull(schema.traefikConfigs.environmentId)))
    if (usedByTraefik) throw validationError({ policy: 'Réseau utilisé par la configuration Traefik : changer d\'abord le réseau Traefik' })
  }

  const { idByKey } = await environmentMaps()
  const { allowedEnvironmentKeys, ...rest } = patch
  await db().update(schema.networks).set({
    ...rest,
    ...(allowedEnvironmentKeys ? { allowedEnvironmentIds: allowedEnvironmentKeys.map(k => idByKey.get(k)!) } : {}),
  }).where(eq(schema.networks.id, id))

  await audit({
    actorUserId: user.id, actorLabel: user.email, action: 'network.update', targetType: 'network', targetId: id, serverId: ep.serverId,
    outcome: 'success', ip: clientIp(event), details: { name: net.name, before: { policy: net.policy, role: net.role }, patch },
  })
  return { ok: true }
})
