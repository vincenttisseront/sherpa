import { and, eq, inArray, isNotNull, or } from 'drizzle-orm'
import { projectArchiveInput } from '../../../../shared/schemas/projects'
import { ACTIVE_STATUSES } from '../../../../shared/utils/deployment-status'
import { db, schema } from '../../../db/client'
import { audit } from '../../../utils/audit'
import { clientIp, requirePermission } from '../../../utils/auth'
import { idParam, readValidated } from '../../../utils/validation'

defineRouteMeta({ openAPI: { tags: ['projects'], summary: 'Archive (ou désarchive) un projet : masqué des listes et du tableau de bord, plus déployable ; refusé tant qu\'une stack est déployée' } })

export default defineEventHandler(async (event) => {
  const { id } = await getValidatedRouterParams(event, idParam.parse)
  const user = await requirePermission(event, 'project:update', { projectId: id })
  const { archived } = await readValidated(event, projectArchiveInput)
  const [p] = await db().select().from(schema.projects).where(eq(schema.projects.id, id))
  if (!p) throw createError({ statusCode: 404, statusMessage: 'Projet introuvable' })

  if (archived) {
    // Rien ne doit tourner : stacks supprimées d'abord (elles resteraient sinon hors de toute vue).
    const pt = schema.projectTargets
    const deployed = await db().select({ env: schema.environments.name }).from(pt)
      .innerJoin(schema.environments, eq(schema.environments.id, pt.environmentId))
      .where(and(eq(pt.projectId, id), or(isNotNull(pt.currentReleaseId), isNotNull(pt.portainerStackId))))
    if (deployed.length) throw createError({ statusCode: 409, statusMessage: `Supprimer d'abord la stack déployée (${deployed.map(d => d.env).join(', ')}) : un projet archivé ne doit plus rien faire tourner` })
    const targets = await db().select({ id: pt.id }).from(pt).where(eq(pt.projectId, id))
    const busy = targets.length ? await db().$count(schema.deployments, and(inArray(schema.deployments.targetId, targets.map(t => t.id)), inArray(schema.deployments.status, [...ACTIVE_STATUSES]))) : 0
    if (busy) throw createError({ statusCode: 409, statusMessage: 'Une opération est en cours sur ce projet' })
  }

  const archivedAt = archived ? new Date() : null
  await db().update(schema.projects).set({ archivedAt }).where(eq(schema.projects.id, id))
  await audit({ actorUserId: user.id, actorLabel: user.email, action: archived ? 'project.archive' : 'project.unarchive', targetType: 'project', targetId: id, projectId: id, outcome: 'success', ip: clientIp(event), details: { slug: p.slug } })
  return { archivedAt: archivedAt?.toISOString() ?? null }
})
