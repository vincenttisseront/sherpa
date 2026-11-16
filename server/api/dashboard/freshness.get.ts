import { and, inArray, isNotNull } from 'drizzle-orm'
import { z } from 'zod'
import type { TargetFreshness } from '../../../shared/schemas/dashboard'
import { db, schema } from '../../db/client'
import { requireAnyPermission } from '../../utils/auth'
import { visibleTargetIds } from '../../services/access'
import { freshnessOf } from '../../services/image-freshness'

defineRouteMeta({ openAPI: { tags: ['dashboard'], summary: 'Images en service comparées à leur registre (à jour, nouvelle version publiée), cible par cible ; indépendant de Watchtower' } })

export default defineEventHandler(async (event): Promise<TargetFreshness[]> => {
  const user = await requireAnyPermission(event, 'deployment:read')
  const { refresh } = await getValidatedQuery(event, z.object({ refresh: z.enum(['0', '1']).optional() }).parse)
  const visible = await visibleTargetIds(user, 'deployment:read')
  const pt = schema.projectTargets
  const rows = await db().select({ id: pt.id }).from(pt).where(and(isNotNull(pt.currentReleaseId), isNotNull(pt.stackName), visible === null ? undefined : visible.length ? inArray(pt.id, visible) : inArray(pt.id, ['00000000-0000-0000-0000-000000000000'])))
  return freshnessOf(rows.map(r => r.id), refresh === '1')
})
