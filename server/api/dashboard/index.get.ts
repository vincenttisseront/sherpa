import { z } from 'zod'
import { requireAnyPermission } from '../../utils/auth'
import { loadDashboard } from '../../services/dashboard'

defineRouteMeta({ openAPI: { tags: ['dashboard'], summary: 'Indicateurs du tableau de bord, restreints aux droits de l\'utilisateur' } })

export default defineEventHandler(async (event) => {
  const user = await requireAnyPermission(event, 'dashboard:read')
  const { period } = await getValidatedQuery(event, z.object({ period: z.enum(['24h', '7d', '30d', '90d', '6m']).default('7d') }).parse)
  return loadDashboard(user, period)
})
