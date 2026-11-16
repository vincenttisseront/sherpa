import { asc, eq } from 'drizzle-orm'
import type { NetworkDto } from '../../../../shared/schemas/servers'
import { db, schema } from '../../../db/client'
import { requirePermission } from '../../../utils/auth'
import { idParam } from '../../../utils/validation'
import { environmentMaps, getEndpointOr404 } from '../../../services/servers'

defineRouteMeta({ openAPI: { tags: ['endpoints'], summary: 'Réseaux découverts et leur politique' } })

export default defineEventHandler(async (event): Promise<NetworkDto[]> => {
  const { id } = await getValidatedRouterParams(event, idParam.parse)
  const ep = await getEndpointOr404(id)
  await requirePermission(event, 'server:read', { serverId: ep.serverId })
  const { keyById } = await environmentMaps()
  const rows = await db().select().from(schema.networks).where(eq(schema.networks.endpointId, id)).orderBy(asc(schema.networks.missing), asc(schema.networks.name))
  return rows.map(n => ({
    id: n.id, name: n.name, driver: n.driver, scope: n.scope, internal: n.internal, labels: n.labels,
    policy: n.policy, role: n.role, external: n.external, description: n.description, tags: n.tags,
    allowedEnvironmentKeys: n.allowedEnvironmentIds.map(e => keyById.get(e)).filter((k): k is string => !!k),
    missing: n.missing, discoveredAt: n.discoveredAt.toISOString(),
  }))
})
