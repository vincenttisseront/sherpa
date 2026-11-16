import { z } from 'zod'
import { portainer } from '../../../../../adapters/portainer'
import { canOn, requireAnyPermission } from '../../../../../utils/auth'
import { redactPatterns } from '../../../../../utils/redact'
import { connectionFor } from '../../../../../services/servers'
import { liveEndpoints } from '../../../../../services/live'

defineRouteMeta({ openAPI: { tags: ['live'], summary: 'Dernières lignes de log d\'un conteneur (secrets masqués)' } })

const params = z.object({ id: z.uuid(), cid: z.string().regex(/^[a-f0-9]{12,64}$/) })

export default defineEventHandler(async (event) => {
  const user = await requireAnyPermission(event, 'logs:read')
  const { id, cid } = await getValidatedRouterParams(event, params.parse)
  const { tail } = await getValidatedQuery(event, z.object({ tail: z.coerce.number().int().min(10).max(2000).default(200) }).parse)
  const [row] = await liveEndpoints(user, id)
  if (!row || !canOn(user, 'logs:read', { serverId: row.server.id })) throw createError({ statusCode: 404, statusMessage: 'Endpoint introuvable' })
  const conn = await connectionFor(row.server)
  const lines = await portainer().containerLogs(conn, row.ep.portainerEndpointId, cid, tail)
  return { lines: lines.map(l => redactPatterns(l)), at: new Date().toISOString() }
})
