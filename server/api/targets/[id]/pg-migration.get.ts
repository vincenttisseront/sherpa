import { z } from 'zod'
import type { PgMigrationPlan } from '../../../../shared/schemas/pg-migration'
import { requirePermission } from '../../../utils/auth'
import { idParam } from '../../../utils/validation'
import { pgMigrationPlan } from '../../../services/pg-migration'
import { getTargetOr404, targetScope } from '../../../services/projects'

defineRouteMeta({ openAPI: { tags: ['targets'], summary: 'Plan de migration d\'un service PostgreSQL vers une nouvelle version majeure (volume, PGDATA, versions publiées, empêchements)' } })

const query = z.object({ service: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,62}$/) })

export default defineEventHandler(async (event): Promise<PgMigrationPlan> => {
  const { id } = await getValidatedRouterParams(event, idParam.parse)
  const { service } = await getValidatedQuery(event, query.parse)
  const t = await getTargetOr404(id)
  await requirePermission(event, 'deployment:execute', targetScope(t))
  return pgMigrationPlan(t, service)
})
