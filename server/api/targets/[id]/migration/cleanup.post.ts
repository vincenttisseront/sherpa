import { migrationCleanupInput } from '../../../../../shared/schemas/migration'
import { audit } from '../../../../utils/audit'
import { clientIp, requirePermission } from '../../../../utils/auth'
import { requestProgress } from '../../../../utils/progress'
import { idParam, readValidated } from '../../../../utils/validation'
import { cleanupMigrationSource, sideOf } from '../../../../services/stack-migration'
import { getTargetOr404, targetScope } from '../../../../services/projects'

defineRouteMeta({ openAPI: { tags: ['targets'], summary: 'Supprime l\'ancienne stack (arrêtée) laissée sur le serveur d\'origine après une migration, et au choix ses données' } })

export default defineEventHandler(async (event) => {
  const { id } = await getValidatedRouterParams(event, idParam.parse)
  const t = await getTargetOr404(id)
  await requirePermission(event, 'deployment:delete', targetScope(t))
  const input = await readValidated(event, migrationCleanupInput)
  const origin = t.target.migratedFrom ? await sideOf(t.target.migratedFrom.endpointId, t.env.id) : null
  const user = await requirePermission(event, 'deployment:delete', { ...targetScope(t), ...(origin ? { serverId: origin.server.id } : {}) })
  const r = await cleanupMigrationSource(t, input, requestProgress(event))
  await audit({ actorUserId: user.id, actorLabel: user.email, action: 'target.migration_cleanup', targetType: 'target', targetId: id, ...targetScope(t), outcome: 'success', ip: clientIp(event), details: { removed: r.removed, removeData: input.removeData } })
  return r
})
