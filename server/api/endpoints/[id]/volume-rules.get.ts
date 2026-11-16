import { asc, eq } from 'drizzle-orm'
import type { VolumeRuleInput } from '../../../../shared/schemas/infra'
import { db, schema } from '../../../db/client'
import { requirePermission } from '../../../utils/auth'
import { idParam } from '../../../utils/validation'
import { environmentMaps, getEndpointOr404 } from '../../../services/servers'

defineRouteMeta({ openAPI: { tags: ['endpoints'], summary: 'Liste blanche des chemins bind de l\'endpoint' } })

export default defineEventHandler(async (event): Promise<VolumeRuleInput[]> => {
  const { id } = await getValidatedRouterParams(event, idParam.parse)
  const ep = await getEndpointOr404(id)
  await requirePermission(event, 'server:read', { serverId: ep.serverId })
  const { keyById } = await environmentMaps()
  const rows = await db().select().from(schema.volumeRules).where(eq(schema.volumeRules.endpointId, id)).orderBy(asc(schema.volumeRules.hostPath))
  return rows.map(r => ({
    hostPath: r.hostPath, mode: r.mode, description: r.description, enabled: r.enabled,
    environmentKey: (r.environmentId ? keyById.get(r.environmentId) ?? null : null) as VolumeRuleInput['environmentKey'],
  }))
})
