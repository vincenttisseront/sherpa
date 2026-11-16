import { requirePermission } from '../../../utils/auth'
import { readinessReport } from '../../../services/readiness'
import { requestProgress } from '../../../utils/progress'

defineRouteMeta({ openAPI: { tags: ['admin'], summary: 'Mise en service : état vérifié de chaque prérequis de production' } })

export default defineEventHandler(async (event) => {
  await requirePermission(event, 'policy:manage')
  // Adresse vue par le navigateur (en-têtes du reverse proxy) : sert seulement à expliquer un écart avec APP_URL.
  const url = getRequestURL(event, { xForwardedHost: true, xForwardedProto: true })
  return readinessReport(requestProgress(event), { origin: url.origin, https: url.protocol === 'https:' })
})
