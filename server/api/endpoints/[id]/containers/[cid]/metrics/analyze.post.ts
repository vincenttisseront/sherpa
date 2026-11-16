import { z } from 'zod'
import { METRIC_RANGES } from '../../../../../../../shared/schemas/metrics'
import { logAnalysisFocus } from '../../../../../../../shared/schemas/ollama'
import { auditedAssist } from '../../../../../../utils/ai-audit'
import { requireAnyPermission } from '../../../../../../utils/auth'
import { requestProgress } from '../../../../../../utils/progress'
import { readValidated } from '../../../../../../utils/validation'
import { analyzeContainerMetrics } from '../../../../../../services/ai-assist'
import { liveEndpoints } from '../../../../../../services/live'

defineRouteMeta({ openAPI: { tags: ['live'], summary: 'Lecture par Ollama de l\'historique des ressources d\'un conteneur (CPU, mémoire, redémarrages) et des déploiements de la période' } })

const params = z.object({ id: z.uuid(), cid: z.string().regex(/^[a-f0-9]{12,64}$/) })
const body = z.object({
  range: z.enum(Object.keys(METRIC_RANGES) as [keyof typeof METRIC_RANGES, ...(keyof typeof METRIC_RANGES)[]]).default('1h'),
  focus: logAnalysisFocus,
}).default({ range: '1h' })

export default defineEventHandler(async (event) => {
  const user = await requireAnyPermission(event, 'server:read')
  const { id, cid } = await getValidatedRouterParams(event, params.parse)
  const { range, focus } = await readValidated(event, body)
  const [row] = await liveEndpoints(user, id)
  if (!row) throw createError({ statusCode: 404, statusMessage: 'Endpoint introuvable' })
  return auditedAssist(event, user, { feature: 'metrics', targetType: 'container', targetId: cid, serverId: row.server.id, withQuestion: !!focus },
    () => analyzeContainerMetrics(row, cid, range, { focus, progress: requestProgress(event) }))
})
