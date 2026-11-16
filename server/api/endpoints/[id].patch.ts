import { eq } from 'drizzle-orm'
import { endpointPatch } from '../../../shared/schemas/infra'
import { db, schema } from '../../db/client'
import { audit } from '../../utils/audit'
import { clientIp, requirePermission } from '../../utils/auth'
import { idParam, readValidated, validationError } from '../../utils/validation'
import { setEndpointEnvironments } from '../../services/infra-config'
import { environmentMaps, getEndpointOr404, loadServerDetail } from '../../services/servers'

defineRouteMeta({ openAPI: { tags: ['endpoints'], summary: 'Active/désactive un endpoint et définit ses environnements' } })

export default defineEventHandler(async (event) => {
  const { id } = await getValidatedRouterParams(event, idParam.parse)
  const ep = await getEndpointOr404(id)
  const user = await requirePermission(event, 'server:manage', { serverId: ep.serverId })
  const patch = await readValidated(event, endpointPatch)

  if (patch.enabled) {
    if (ep.type !== 'docker_standalone') throw validationError({ enabled: 'Seul Docker Standalone est déployable pour l\'instant' })
    if (ep.missing) throw validationError({ enabled: 'Endpoint absent de l\'agent' })
  }
  const { idByKey } = await environmentMaps()
  await db().transaction(async (tx) => {
    if (patch.enabled !== undefined) await tx.update(schema.serverEndpoints).set({ enabled: patch.enabled }).where(eq(schema.serverEndpoints.id, id))
    if (patch.environmentKeys) await setEndpointEnvironments(tx, id, patch.environmentKeys.map(k => idByKey.get(k)!))
  })
  await audit({ actorUserId: user.id, actorLabel: user.email, action: 'endpoint.update', targetType: 'server_endpoint', targetId: id, serverId: ep.serverId, outcome: 'success', ip: clientIp(event), details: { name: ep.name, ...patch } })
  return loadServerDetail(ep.serverId)
})
