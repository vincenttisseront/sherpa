import { z } from 'zod'
import { pgMigrationInput } from '../../../../shared/schemas/pg-migration'
import { audit } from '../../../utils/audit'
import { clientIp, requirePermission } from '../../../utils/auth'
import { idParam, readValidated } from '../../../utils/validation'
import { startPgMigration } from '../../../services/pg-migration'
import { getTargetOr404, targetScope } from '../../../services/projects'

defineRouteMeta({ openAPI: { tags: ['targets'], summary: 'Migre un service PostgreSQL vers une nouvelle version majeure (sauvegarde, restauration, redéploiement ; retour automatique en cas d\'échec)' } })

export default defineEventHandler(async (event) => {
  const { id } = await getValidatedRouterParams(event, idParam.parse)
  const t = await getTargetOr404(id)
  const user = await requirePermission(event, 'deployment:execute', targetScope(t))
  const input = await readValidated(event, pgMigrationInput)
  const key = z.string().regex(/^[A-Za-z0-9_-]{8,128}$/).safeParse(getHeader(event, 'idempotency-key')).data ?? crypto.randomUUID()
  const r = await startPgMigration(t, input, user, `pg-migration:${id}:${key}`)
  await audit({ actorUserId: user.id, actorLabel: user.email, action: 'target.pg_migration', targetType: 'deployment', targetId: r.deploymentId, ...targetScope(t), outcome: 'success', ip: clientIp(event), details: { service: input.service, from: r.from, to: r.to } })
  setResponseStatus(event, 202)
  return r
})
