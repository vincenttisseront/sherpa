import { z } from 'zod'
import { migrationInput } from '../../../../shared/schemas/migration'
import { audit } from '../../../utils/audit'
import { clientIp, requirePermission } from '../../../utils/auth'
import { requestProgress } from '../../../utils/progress'
import { idParam, readValidated } from '../../../utils/validation'
import { sideOf, startMigration } from '../../../services/stack-migration'
import { getTargetOr404, targetScope } from '../../../services/projects'

defineRouteMeta({ openAPI: { tags: ['targets'], summary: 'Migre la stack vers un autre serveur géré (copie des données, démarrage sur la cible, retour automatique en cas d\'échec)' } })

export default defineEventHandler(async (event) => {
  const { id } = await getValidatedRouterParams(event, idParam.parse)
  const t = await getTargetOr404(id)
  const user = await requirePermission(event, 'deployment:execute', targetScope(t))
  const input = await readValidated(event, migrationInput)
  const dest = await sideOf(input.endpointId, t.env.id)
  await requirePermission(event, 'deployment:execute', { ...targetScope(t), serverId: dest.server.id })
  const key = z.string().regex(/^[A-Za-z0-9_-]{8,128}$/).safeParse(getHeader(event, 'idempotency-key')).data ?? crypto.randomUUID()
  const r = await startMigration(t, input, user, `migrate:${id}:${key}`, requestProgress(event))
  await audit({ actorUserId: user.id, actorLabel: user.email, action: 'target.migrate', targetType: 'deployment', targetId: r.deploymentId, ...targetScope(t), outcome: 'success', ip: clientIp(event), details: { stack: t.target.stackName, from: t.server.name, to: dest.server.name, items: input.items } })
  setResponseStatus(event, 202)
  return r
})
