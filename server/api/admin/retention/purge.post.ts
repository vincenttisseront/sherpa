import { maintenanceQueue } from '../../../queue/queues'
import { requirePermission } from '../../../utils/auth'

defineRouteMeta({ openAPI: { tags: ['admin'], summary: 'Lance la purge de rétention (exécutée par le worker, auditée)' } })

export default defineEventHandler(async (event) => {
  const user = await requirePermission(event, 'policy:manage')
  await maintenanceQueue().add('retention-purge', { actor: { id: user.id, label: user.email } }, { removeOnComplete: 50, removeOnFail: 50 })
  setResponseStatus(event, 202)
  return { queued: true }
})
