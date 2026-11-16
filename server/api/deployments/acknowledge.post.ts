import { and, eq, inArray } from 'drizzle-orm'
import { type BulkAcknowledgeResult, deploymentBulkAcknowledge, deploymentListQuery } from '../../../shared/schemas/lists'
import { FAILED_STATUSES } from '../../../shared/utils/deployment-status'
import { db, schema } from '../../db/client'
import { visibleTargetIds } from '../../services/access'
import { listDeployments } from '../../services/lists'
import { audit } from '../../utils/audit'
import { canOn, clientIp, requireAnyPermission } from '../../utils/auth'
import { readValidated } from '../../utils/validation'

defineRouteMeta({ openAPI: { tags: ['deployments'], summary: 'Acquittement groupé d\'échecs (sélection, ou tous les échecs non acquittés des filtres) : droits vérifiés par déploiement' } })

const MAX = 500

export default defineEventHandler(async (event): Promise<BulkAcknowledgeResult> => {
  const user = await requireAnyPermission(event, 'deployment:execute')
  const input = await readValidated(event, deploymentBulkAcknowledge)

  let ids = input.ids ?? []
  if (input.filter) {
    // Mêmes filtres que la liste, restreints aux échecs non acquittés visibles.
    const visible = await visibleTargetIds(user, 'deployment:read')
    const q = deploymentListQuery.parse({ ...input.filter, unacknowledged: 'true', page: 1, pageSize: 100 })
    ids = []
    for (let page = 1; ids.length < MAX; page++) {
      const r = await listDeployments({ ...q, page }, visible)
      ids.push(...r.items.map(i => i.id))
      if (r.items.length < q.pageSize) break
    }
    ids = ids.slice(0, MAX)
  }
  if (!ids.length) return { updated: 0, skipped: 0 }

  const d = schema.deployments
  const rows = await db().select({ id: d.id, status: d.status, ack: d.acknowledgedAt, projectId: schema.projectTargets.projectId, environmentId: schema.projectTargets.environmentId, serverId: schema.serverEndpoints.serverId })
    .from(d)
    .innerJoin(schema.projectTargets, eq(schema.projectTargets.id, d.targetId))
    .innerJoin(schema.serverEndpoints, eq(schema.serverEndpoints.id, schema.projectTargets.endpointId))
    .where(inArray(d.id, ids))
  // Échec, état à changer, et droit d'agir sur ce déploiement précis.
  const eligible = rows.filter(r => FAILED_STATUSES.includes(r.status) && (input.acknowledged ? !r.ack : !!r.ack)
    && canOn(user, 'deployment:execute', { projectId: r.projectId, environmentId: r.environmentId, serverId: r.serverId }))
  if (eligible.length) {
    await db().update(d)
      .set(input.acknowledged ? { acknowledgedAt: new Date(), acknowledgedBy: user.id } : { acknowledgedAt: null, acknowledgedBy: null })
      .where(and(inArray(d.id, eligible.map(r => r.id))))
    for (const r of eligible) {
      await audit({ actorUserId: user.id, actorLabel: user.email, action: input.acknowledged ? 'deployment.acknowledge' : 'deployment.unacknowledge', targetType: 'deployment', targetId: r.id, projectId: r.projectId, environmentId: r.environmentId, serverId: r.serverId, outcome: 'success', ip: clientIp(event), details: { status: r.status, bulk: true } })
    }
  }
  return { updated: eligible.length, skipped: ids.length - eligible.length }
})
