import { z } from 'zod'
import { audit } from '../../../utils/audit'
import { clientIp, requirePermission } from '../../../utils/auth'
import { idParam, readValidated } from '../../../utils/validation'
import { deploymentScope } from '../../../services/deployments'
import { relaunchDeployment } from '../../../services/deploy-requests'

defineRouteMeta({ openAPI: { tags: ['deployments'], summary: 'Relance un déploiement avec les mêmes paramètres (même release), images construites reprises ou reconstruites (en-tête Idempotency-Key recommandé)' } })

const body = z.object({ rebuild: z.boolean().default(false), cleanBuild: z.boolean().default(false), pull: z.boolean().default(true) })

export default defineEventHandler(async (event) => {
  const { id } = await getValidatedRouterParams(event, idParam.parse)
  const input = await readValidated(event, body)
  const scope = await deploymentScope(id)
  const user = await requirePermission(event, 'deployment:execute', scope)
  const key = z.string().regex(/^[A-Za-z0-9_-]{8,128}$/).safeParse(getHeader(event, 'idempotency-key')).data ?? crypto.randomUUID()
  try {
    const deploymentId = await relaunchDeployment(id, input, user.id, `relaunch:${id}:${key}`)
    await audit({ actorUserId: user.id, actorLabel: user.email, action: 'deployment.relaunch', targetType: 'deployment', targetId: deploymentId, ...scope, outcome: 'success', ip: clientIp(event), details: { from: id, ...input } })
    setResponseStatus(event, 202)
    return { deploymentId }
  }
  catch (err) {
    await audit({ actorUserId: user.id, actorLabel: user.email, action: 'deployment.relaunch', targetType: 'deployment', targetId: id, ...scope, outcome: 'failure', ip: clientIp(event), details: { error: (err as Error).message } })
    throw err
  }
})
