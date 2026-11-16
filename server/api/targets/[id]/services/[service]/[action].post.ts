import { z } from 'zod'
import { SERVICE_ACTIONS } from '../../../../../../shared/schemas/diagnostic'
import { audit } from '../../../../../utils/audit'
import { clientIp, requirePermission } from '../../../../../utils/auth'
import { serviceAction } from '../../../../../services/diagnostic'
import { getTargetOr404, targetScope } from '../../../../../services/projects'

defineRouteMeta({ openAPI: { tags: ['targets'], summary: 'Démarre, arrête ou redémarre le conteneur d\'un service de la cible (sans redéployer)' } })

const params = z.object({ id: z.uuid(), service: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,99}$/), action: z.enum(SERVICE_ACTIONS) })

export default defineEventHandler(async (event) => {
  const { id, service, action } = await getValidatedRouterParams(event, params.parse)
  const t = await getTargetOr404(id)
  const user = await requirePermission(event, action === 'stop' ? 'deployment:stop' : 'deployment:execute', targetScope(t))
  const base = { actorUserId: user.id, actorLabel: user.email, action: `target.service_${action}`, targetType: 'project_target', targetId: t.target.id, ...targetScope(t), ip: clientIp(event) }
  try {
    const container = await serviceAction(t, service, action)
    await audit({ ...base, outcome: 'success', details: { service, container } })
    return { ok: true, container }
  }
  catch (err) {
    await audit({ ...base, outcome: 'failure', details: { service, error: (err as Error).message } })
    throw err
  }
})
