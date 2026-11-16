import { z } from 'zod'
import { logAnalysisFocus } from '../../../../../shared/schemas/ollama'
import { schema } from '../../../../db/client'
import { audit } from '../../../../utils/audit'
import { clientIp, requirePermission } from '../../../../utils/auth'
import { requestProgress } from '../../../../utils/progress'
import { idParam, readValidated } from '../../../../utils/validation'
import { deploymentScope } from '../../../../services/deployments'
import { analyzeLogsWithOllama, deploymentLogLines, deploymentSource } from '../../../../services/log-analysis'

defineRouteMeta({ openAPI: { tags: ['deployments'], summary: 'Analyse par Ollama des dernières lignes du journal d\'un déploiement (secrets masqués avant envoi)' } })

const body = z.object({
  levels: z.array(z.enum(schema.logLevel.enumValues)).max(4).optional(),
  phases: z.array(z.enum(schema.logPhase.enumValues)).max(10).optional(),
  service: z.string().max(200).optional(),
  limit: z.number().int().min(20).max(2000).default(1000),
  focus: logAnalysisFocus,
}).default({ limit: 1000 })

export default defineEventHandler(async (event) => {
  const { id } = await getValidatedRouterParams(event, idParam.parse)
  const scope = await deploymentScope(id)
  const user = await requirePermission(event, 'logs:read', scope)
  const { focus, ...filter } = await readValidated(event, body)
  const progress = requestProgress(event)
  const base = { actorUserId: user.id, actorLabel: user.email, action: 'ollama.analyze', targetType: 'deployment', targetId: id, serverId: scope.serverId, environmentId: scope.environmentId, projectId: scope.projectId, ip: clientIp(event) }
  try {
    await progress.step('Lecture des logs du déploiement', 1, 2)
    const lines = await deploymentLogLines(id, filter)
    await progress.step('Analyse par le modèle Ollama (peut prendre une minute)', 2, 2)
    const analysis = await analyzeLogsWithOllama({ lines, source: await deploymentSource(scope), focus })
    await audit({ ...base, outcome: 'success', details: { source: 'deployment', model: analysis.meta.model, totalLines: analysis.meta.totalLines, sentLines: analysis.meta.sentLines, durationMs: analysis.meta.durationMs, withQuestion: !!focus } })
    return analysis
  }
  catch (err) {
    await audit({ ...base, outcome: 'failure', details: { source: 'deployment', error: (err as { statusMessage?: string }).statusMessage ?? 'Erreur' } })
    throw err
  }
})
