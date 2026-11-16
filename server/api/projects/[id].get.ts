import { requireUser, canOn } from '../../utils/auth'
import { canOnProject, targetScopes } from '../../services/access'
import { idParam } from '../../utils/validation'
import { loadProjectDetail } from '../../services/project-views'

defineRouteMeta({ openAPI: { tags: ['projects'], summary: 'Détail d\'un projet et de ses cibles' } })

export default defineEventHandler(async (event) => {
  const { id } = await getValidatedRouterParams(event, idParam.parse)
  const user = requireUser(event)
  const scopes = await targetScopes([id])
  if (!canOnProject(user, 'project:read', id, scopes)) throw createError({ statusCode: 404, statusMessage: 'Projet introuvable' })
  const p = await loadProjectDetail(id)
  // Seules les cibles (environnements) autorisées sont présentées.
  p.targets = p.targets.filter(t => canOn(user, 'project:read', { projectId: id, serverId: t.server.id, environmentId: t.environment.id }))
  return p
})
