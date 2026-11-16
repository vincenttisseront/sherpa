import { requirePermission } from '../../../utils/auth'
import { idParam } from '../../../utils/validation'
import { buildAnalyzeContext, getTargetOr404, targetScope } from '../../../services/projects'

defineRouteMeta({ openAPI: { tags: ['targets'], summary: 'Expositions Traefik de la cible et configuration Traefik de l\'endpoint' } })

export default defineEventHandler(async (event) => {
  const { id } = await getValidatedRouterParams(event, idParam.parse)
  const t = await getTargetOr404(id)
  await requirePermission(event, 'project:read', targetScope(t))
  const ctx = await buildAnalyzeContext(t, { composePath: 'compose.yml', files: new Set(), releaseSlug: 'r-0000-000000', portApprovals: [] })
  return { exposures: t.target.exposures, traefik: ctx.traefik, takenHosts: ctx.takenHosts }
})
