import type { MigrationDestination } from '../../../../../shared/schemas/migration'
import { requirePermission } from '../../../../utils/auth'
import { idParam } from '../../../../utils/validation'
import { migrationDestinations } from '../../../../services/stack-migration'
import { getTargetOr404, targetScope } from '../../../../services/projects'

defineRouteMeta({ openAPI: { tags: ['targets'], summary: 'Serveurs vers lesquels la stack peut être migrée (et raison sinon)' } })

export default defineEventHandler(async (event): Promise<MigrationDestination[]> => {
  const { id } = await getValidatedRouterParams(event, idParam.parse)
  const t = await getTargetOr404(id)
  await requirePermission(event, 'deployment:execute', targetScope(t))
  return migrationDestinations(t)
})
