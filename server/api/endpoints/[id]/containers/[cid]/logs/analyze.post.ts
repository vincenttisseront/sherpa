import { z } from 'zod'
import { logAnalysisFocus } from '../../../../../../../shared/schemas/ollama'
import { portainer } from '../../../../../../adapters/portainer'
import { auditedAssist } from '../../../../../../utils/ai-audit'
import { canOn, requireAnyPermission } from '../../../../../../utils/auth'
import { requestProgress } from '../../../../../../utils/progress'
import { readValidated } from '../../../../../../utils/validation'
import { liveEndpoints } from '../../../../../../services/live'
import { analyzeLogsWithOllama } from '../../../../../../services/log-analysis'
import { connectionFor } from '../../../../../../services/servers'

defineRouteMeta({ openAPI: { tags: ['live'], summary: 'Analyse par Ollama des dernières lignes de log d\'un conteneur (secrets masqués avant envoi)' } })

const params = z.object({ id: z.uuid(), cid: z.string().regex(/^[a-f0-9]{12,64}$/) })
const body = z.object({
  tail: z.number().int().min(10).max(2000).default(300),
  focus: logAnalysisFocus,
}).default({ tail: 300 })

export default defineEventHandler(async (event) => {
  const user = await requireAnyPermission(event, 'logs:read')
  const { id, cid } = await getValidatedRouterParams(event, params.parse)
  const { tail, focus } = await readValidated(event, body)
  const [row] = await liveEndpoints(user, id)
  if (!row || !canOn(user, 'logs:read', { serverId: row.server.id })) throw createError({ statusCode: 404, statusMessage: 'Endpoint introuvable' })
  const progress = requestProgress(event)
  return auditedAssist(event, user, { feature: 'logs', targetType: 'container', targetId: cid, serverId: row.server.id, withQuestion: !!focus }, async () => {
    await progress.step('Lecture des logs du conteneur', 1, 2)
    const lines = await portainer().containerLogs(await connectionFor(row.server), row.ep.portainerEndpointId, cid, tail)
    await progress.step('Analyse par le modèle Ollama (peut prendre une minute)', 2, 2)
    return analyzeLogsWithOllama({ lines, source: `Conteneur ${cid.slice(0, 12)} (hôte ${row.server.name})`, focus })
  })
})
