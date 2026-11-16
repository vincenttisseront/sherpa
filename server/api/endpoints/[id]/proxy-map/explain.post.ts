import { z } from 'zod'
import { logAnalysisFocus } from '../../../../../shared/schemas/ollama'
import { auditedAssist } from '../../../../utils/ai-audit'
import { requireAnyPermission } from '../../../../utils/auth'
import { requestProgress } from '../../../../utils/progress'
import { idParam, readValidated } from '../../../../utils/validation'
import { explainProxies } from '../../../../services/ai-assist'
import { liveEndpoints } from '../../../../services/live'

defineRouteMeta({ openAPI: { tags: ['proxy'], summary: 'Explication par Ollama des reverse proxies d\'un hôte : routes, certificats, erreurs ACME, ports publiés (extraction par liste blanche)' } })

const body = z.object({ focus: logAnalysisFocus }).default({})

export default defineEventHandler(async (event) => {
  const { id } = await getValidatedRouterParams(event, idParam.parse)
  const user = await requireAnyPermission(event, 'server:read')
  const { focus } = await readValidated(event, body)
  const [row] = await liveEndpoints(user, id)
  if (!row) throw createError({ statusCode: 404, statusMessage: 'Endpoint introuvable' })
  return auditedAssist(event, user, { feature: 'proxy', targetType: 'endpoint', targetId: id, serverId: row.server.id, withQuestion: !!focus },
    () => explainProxies(row, { focus, progress: requestProgress(event) }))
})
