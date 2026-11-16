import { z } from 'zod'
import type { MigrationPlan } from '../../../../shared/schemas/migration'
import { requirePermission } from '../../../utils/auth'
import { requestProgress } from '../../../utils/progress'
import { idParam } from '../../../utils/validation'
import { migrationPlan, sideOf } from '../../../services/stack-migration'
import { getTargetOr404, targetScope } from '../../../services/projects'

defineRouteMeta({ openAPI: { tags: ['targets'], summary: 'Plan de migration de la stack vers un autre serveur (données copiées, empêchements, analyse sur la cible)' } })

const query = z.object({ to: z.uuid() })

export default defineEventHandler(async (event): Promise<MigrationPlan> => {
  const { id } = await getValidatedRouterParams(event, idParam.parse)
  const { to } = await getValidatedQuery(event, query.parse)
  const t = await getTargetOr404(id)
  await requirePermission(event, 'deployment:execute', targetScope(t))
  const dest = await sideOf(to, t.env.id)
  await requirePermission(event, 'deployment:execute', { ...targetScope(t), serverId: dest.server.id })
  return migrationPlan(t, to, requestProgress(event))
})
