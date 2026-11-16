import { z } from 'zod'
import { eq } from 'drizzle-orm'
import { db, schema } from '../../../db/client'
import { audit } from '../../../utils/audit'
import { clientIp, requirePermission } from '../../../utils/auth'
import { idParam, readValidated } from '../../../utils/validation'
import { deploymentScope } from '../../../services/deployments'
import { FAILED_STATUSES } from '../../../../shared/utils/deployment-status'

defineRouteMeta({ openAPI: { tags: ['deployments'], summary: 'Acquitte (ou rétablit) un déploiement en échec : retiré du tableau de bord, conservé dans l\'historique' } })

const body = z.object({ acknowledged: z.boolean().default(true) })

export default defineEventHandler(async (event) => {
  const { id } = await getValidatedRouterParams(event, idParam.parse)
  const input = await readValidated(event, body)
  const scope = await deploymentScope(id)
  const user = await requirePermission(event, 'deployment:execute', scope)
  const [d] = await db().select({ status: schema.deployments.status }).from(schema.deployments).where(eq(schema.deployments.id, id))
  if (!d) throw createError({ statusCode: 404, statusMessage: 'Déploiement introuvable' })
  if (!FAILED_STATUSES.includes(d.status)) throw createError({ statusCode: 409, statusMessage: 'Seul un déploiement en échec peut être acquitté' })
  await db().update(schema.deployments)
    .set(input.acknowledged ? { acknowledgedAt: new Date(), acknowledgedBy: user.id } : { acknowledgedAt: null, acknowledgedBy: null })
    .where(eq(schema.deployments.id, id))
  await audit({ actorUserId: user.id, actorLabel: user.email, action: input.acknowledged ? 'deployment.acknowledge' : 'deployment.unacknowledge', targetType: 'deployment', targetId: id, projectId: scope.projectId, environmentId: scope.environmentId, serverId: scope.serverId, outcome: 'success', ip: clientIp(event), details: { status: d.status } })
  return { acknowledged: input.acknowledged }
})
