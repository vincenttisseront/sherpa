import { adoptionConfirm } from '../../../../../shared/schemas/adoption'
import { audit } from '../../../../utils/audit'
import { clientIp, requireAnyPermission, requirePermission } from '../../../../utils/auth'
import { requestProgress } from '../../../../utils/progress'
import { idParam, pgCode, readValidated, validationError } from '../../../../utils/validation'
import { liveEndpoints } from '../../../../services/live'
import { adoptStack } from '../../../../services/adoption'

defineRouteMeta({ openAPI: { tags: ['adoption'], summary: 'Reprend une stack existante en projet géré (aucune modification sur le serveur avant le premier déploiement)' } })

export default defineEventHandler(async (event) => {
  const { id } = await getValidatedRouterParams(event, idParam.parse)
  const user = await requireAnyPermission(event, 'project:create')
  const [row] = await liveEndpoints(user, id)
  if (!row) throw createError({ statusCode: 404, statusMessage: 'Endpoint introuvable' })
  await requirePermission(event, 'server:manage', { serverId: row.server.id })
  const input = await readValidated(event, adoptionConfirm)
  const r = await adoptStack(row, input, user.id, requestProgress(event)).catch((err) => {
    if (pgCode(err) === '23505') throw validationError({ slug: 'Identifiant déjà utilisé' })
    throw err
  })
  await audit({
    actorUserId: user.id,
    actorLabel: user.email,
    action: 'project.adopt',
    targetType: 'project',
    targetId: r.projectId,
    projectId: r.projectId,
    serverId: row.server.id,
    outcome: 'success',
    ip: clientIp(event),
    details: {
      stack: input.stack,
      endpoint: row.ep.name,
      environment: input.environmentKey,
      exposures: r.preview.exposures.length,
      variables: r.preview.variables.length,
      droppedRoutes: r.preview.droppedRoutes.length,
    },
  })
  setResponseStatus(event, 201)
  return { projectId: r.projectId, targetId: r.targetId, upload: r.upload }
})
