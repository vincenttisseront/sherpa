import { requestProgress } from '../../../../utils/progress'
import { requirePermission } from '../../../../utils/auth'
import { idParam } from '../../../../utils/validation'
import { liveEndpoints } from '../../../../services/live'
import { previewCleanup } from '../../../../services/cleanup'

defineRouteMeta({ openAPI: { tags: ['cleanup'], summary: 'Nettoyage Docker : occupation disque et candidats (avec protections)' } })

export default defineEventHandler(async (event) => {
  const { id } = await getValidatedRouterParams(event, idParam.parse)
  const user = event.context.user!
  const [row] = await liveEndpoints(user, id)
  if (!row) throw createError({ statusCode: 404, statusMessage: 'Endpoint introuvable' })
  await requirePermission(event, 'server:manage', { serverId: row.server.id })
  return previewCleanup(row, requestProgress(event))
})
