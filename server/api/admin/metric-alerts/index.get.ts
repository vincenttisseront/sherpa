import { alertsOverview } from '../../../services/metrics'
import { requirePermission } from '../../../utils/auth'

defineRouteMeta({ openAPI: { tags: ['admin'], summary: 'Règles d\'alerte de ressources, alertes en cours et récentes, état des relevés' } })

export default defineEventHandler(async (event) => {
  await requirePermission(event, 'notification:manage')
  return alertsOverview()
})
