import { z } from 'zod'
import { logAnalysisFocus } from '../../../../../../../shared/schemas/ollama'
import { portainer } from '../../../../../../adapters/portainer'
import { audit } from '../../../../../../utils/audit'
import { canOn, clientIp, requireAnyPermission } from '../../../../../../utils/auth'
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
  const base = { actorUserId: user.id, actorLabel: user.email, action: 'ollama.analyze', targetType: 'container', targetId: cid, serverId: row.server.id, ip: clientIp(event) }
  try {
    await progress.step('Lecture des logs du conteneur', 1, 2)
    const lines = await portainer().containerLogs(await connectionFor(row.server), row.ep.portainerEndpointId, cid, tail)
    await progress.step('Analyse par le modèle Ollama (peut prendre une minute)', 2, 2)
    const analysis = await analyzeLogsWithOllama({ lines, source: `Conteneur ${cid.slice(0, 12)} (hôte ${row.server.name})`, focus })
    await audit({ ...base, outcome: 'success', details: { source: 'container', model: analysis.meta.model, totalLines: analysis.meta.totalLines, sentLines: analysis.meta.sentLines, durationMs: analysis.meta.durationMs, withQuestion: !!focus } })
    return analysis
  }
  catch (err) {
    await audit({ ...base, outcome: 'failure', details: { source: 'container', error: (err as { statusMessage?: string }).statusMessage ?? 'Erreur' } })
    throw err
  }
})
