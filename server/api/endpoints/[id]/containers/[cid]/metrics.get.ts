import { z } from 'zod'
import { METRIC_RANGES } from '../../../../../../shared/schemas/metrics'
import { portainer } from '../../../../../adapters/portainer'
import { metricsFor } from '../../../../../services/metrics'
import { liveEndpoints } from '../../../../../services/live'
import { connectionFor } from '../../../../../services/servers'
import { requireAnyPermission } from '../../../../../utils/auth'

defineRouteMeta({ openAPI: { tags: ['live'], summary: 'Historique des ressources d\'un conteneur déployé par la plateforme (CPU, mémoire, redémarrages) et ses alertes en cours' } })

const params = z.object({ id: z.uuid(), cid: z.string().regex(/^[a-f0-9]{12,64}$/) })
const query = z.object({ range: z.enum(Object.keys(METRIC_RANGES) as [keyof typeof METRIC_RANGES, ...(keyof typeof METRIC_RANGES)[]]).default('1h') })

export default defineEventHandler(async (event) => {
  const user = await requireAnyPermission(event, 'server:read')
  const { id, cid } = await getValidatedRouterParams(event, params.parse)
  const { range } = await getValidatedQuery(event, query.parse)
  const [row] = await liveEndpoints(user, id)
  if (!row) throw createError({ statusCode: 404, statusMessage: 'Endpoint introuvable' })
  // Les relevés sont rangés par nom de conteneur (stable d'un déploiement à l'autre).
  const container = await portainer().inspectContainer(await connectionFor(row.server), row.ep.portainerEndpointId, cid)
  if (!container) throw createError({ statusCode: 404, statusMessage: 'Conteneur introuvable' })
  return metricsFor(row.ep.id, container.name, range)
})
