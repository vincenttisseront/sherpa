import { canOn, requireAnyPermission } from '../utils/auth'
import { deployOptions } from '../services/project-views'

defineRouteMeta({ openAPI: { tags: ['projects'], summary: 'Endpoints et environnements disponibles pour un déploiement' } })

export default defineEventHandler(async (event) => {
  const user = await requireAnyPermission(event, 'project:create')
  const all = await deployOptions()
  return all
    .map(o => ({ ...o, environments: o.environments.filter(e => canOn(user, 'project:create', { serverId: o.serverId, environmentId: e.id })) }))
    .filter(o => o.environments.length)
})
