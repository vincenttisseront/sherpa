import { requestProgress } from '../../../../utils/progress'
import { audit } from '../../../../utils/audit'
import { clientIp, requirePermission } from '../../../../utils/auth'
import { idParam } from '../../../../utils/validation'
import { type DiagnosticResult, diagnoseRunner, getRunnerRow } from '../../../../services/runner-admin'
import { getEndpointOr404, getServerOr404 } from '../../../../services/servers'
import { env } from '../../../../utils/env'

defineRouteMeta({ openAPI: { tags: ['runner'], summary: 'Diagnostic complet du Runner, ou des fichiers et du build par SSH (crée les répertoires configurés si autorisé)' } })

export default defineEventHandler(async (event): Promise<DiagnosticResult> => {
  const { id } = await getValidatedRouterParams(event, idParam.parse)
  const ep = await getEndpointOr404(id)
  const user = await requirePermission(event, 'path:manage', { serverId: ep.serverId })
  // Hôte joint en SSH : aucun Runner à enregistrer, les actions passent par la connexion SSH.
  const viaSsh = (await getServerOr404(ep.serverId)).transport === 'ssh'
  if (env().RUNNER_ADAPTER === 'http' && !viaSsh && !(await getRunnerRow(id))) throw createError({ statusCode: 404, statusMessage: 'Aucun Runner configuré' })
  const result = await diagnoseRunner(id, user.email, requestProgress(event))
  await audit({
    actorUserId: user.id, actorLabel: user.email, action: 'runner.diagnose', targetType: 'server_endpoint', targetId: id, serverId: ep.serverId,
    outcome: result.ok ? 'success' : 'failure', ip: clientIp(event), details: { steps: result.steps.map(s => ({ key: s.key, status: s.status, detail: s.detail })) },
  })
  return result
})
