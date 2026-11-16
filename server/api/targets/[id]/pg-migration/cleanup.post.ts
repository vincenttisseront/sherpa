import { z } from 'zod'
import { audit } from '../../../../utils/audit'
import { clientIp, requirePermission } from '../../../../utils/auth'
import { idParam, readValidated } from '../../../../utils/validation'
import { removeOldPgCluster } from '../../../../services/pg-migration'
import { getTargetOr404, targetScope } from '../../../../services/projects'

defineRouteMeta({ openAPI: { tags: ['targets'], summary: 'Supprime l\'ancien cluster PostgreSQL après validation de la migration (et, en option, sa sauvegarde)' } })

const body = z.object({ service: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,62}$/), confirm: z.string(), removeBackup: z.boolean().default(false) })

export default defineEventHandler(async (event) => {
  const { id } = await getValidatedRouterParams(event, idParam.parse)
  const t = await getTargetOr404(id)
  const user = await requirePermission(event, 'deployment:execute', targetScope(t))
  const input = await readValidated(event, body)
  const r = await removeOldPgCluster(t, input)
  await audit({ actorUserId: user.id, actorLabel: user.email, action: 'target.pg_cleanup', targetType: 'project_target', targetId: id, ...targetScope(t), outcome: 'success', ip: clientIp(event), details: { service: input.service, backupRemoved: r.backupRemoved } })
  return r
})
