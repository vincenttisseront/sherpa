import { asc, eq } from 'drizzle-orm'
import type { VolumeDto } from '../../../../shared/schemas/servers'
import { db, schema } from '../../../db/client'
import { requirePermission } from '../../../utils/auth'
import { idParam } from '../../../utils/validation'
import { getEndpointOr404 } from '../../../services/servers'

defineRouteMeta({ openAPI: { tags: ['endpoints'], summary: 'Volumes Docker découverts' } })

export default defineEventHandler(async (event): Promise<VolumeDto[]> => {
  const { id } = await getValidatedRouterParams(event, idParam.parse)
  const ep = await getEndpointOr404(id)
  await requirePermission(event, 'server:read', { serverId: ep.serverId })
  const rows = await db().select().from(schema.dockerVolumes).where(eq(schema.dockerVolumes.endpointId, id)).orderBy(asc(schema.dockerVolumes.missing), asc(schema.dockerVolumes.name))
  return rows.map(v => ({ id: v.id, name: v.name, driver: v.driver, mountpoint: v.mountpoint, labels: v.labels, missing: v.missing, discoveredAt: v.discoveredAt.toISOString() }))
})
