import { z } from 'zod'
import type { ImageUpgradePlan } from '../../../../shared/schemas/image-upgrade'
import { requirePermission } from '../../../utils/auth'
import { idParam } from '../../../utils/validation'
import { upgradePlan } from '../../../services/image-upgrade'
import { getTargetOr404, targetScope } from '../../../services/projects'

defineRouteMeta({ openAPI: { tags: ['targets'], summary: 'Plan de mise à niveau des images : origine dans le Compose, versions plus récentes de même forme, nouvelles publications du même tag' } })

export default defineEventHandler(async (event): Promise<ImageUpgradePlan> => {
  const { id } = await getValidatedRouterParams(event, idParam.parse)
  const { refresh } = await getValidatedQuery(event, z.object({ refresh: z.enum(['0', '1']).optional() }).parse)
  const t = await getTargetOr404(id)
  await requirePermission(event, 'project:read', targetScope(t))
  return upgradePlan(t, { refresh: refresh === '1' })
})
