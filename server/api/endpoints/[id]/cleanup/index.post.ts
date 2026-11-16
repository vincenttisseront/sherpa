import { requestProgress } from '../../../../utils/progress'
import { cleanupInput } from '../../../../../shared/schemas/cleanup'
import { requirePermission } from '../../../../utils/auth'
import { idParam, readValidated } from '../../../../utils/validation'
import { liveEndpoints } from '../../../../services/live'
import { runCleanup } from '../../../../services/cleanup'

defineRouteMeta({ openAPI: { tags: ['cleanup'], summary: 'Exécute le nettoyage Docker choisi (ressources protégées exclues, audité)' } })

export default defineEventHandler(async (event) => {
  const { id } = await getValidatedRouterParams(event, idParam.parse)
  const user = event.context.user!
  const [row] = await liveEndpoints(user, id)
  if (!row) throw createError({ statusCode: 404, statusMessage: 'Endpoint introuvable' })
  await requirePermission(event, 'server:manage', { serverId: row.server.id })
  return runCleanup(row, await readValidated(event, cleanupInput), user, requestProgress(event))
})
