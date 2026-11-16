import { z } from 'zod'
import { requirePermission } from '../../../../../utils/auth'
import { listFileVersions } from '../../../../../services/service-files'
import { getTargetOr404, targetScope } from '../../../../../services/projects'

defineRouteMeta({ openAPI: { tags: ['targets'], summary: 'Versions gardées d\'un fichier d\'un service (copies faites avant chaque modification par la console)' } })

const params = z.object({ id: z.uuid(), service: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,99}$/) })
const query = z.object({ mount: z.string().min(1).max(1024), path: z.string().min(1).max(1024) })

export default defineEventHandler(async (event) => {
  const { id, service } = await getValidatedRouterParams(event, params.parse)
  const q = await getValidatedQuery(event, query.parse)
  const t = await getTargetOr404(id)
  await requirePermission(event, 'deployment:execute', targetScope(t))
  return listFileVersions(t, service, q.mount, q.path)
})
