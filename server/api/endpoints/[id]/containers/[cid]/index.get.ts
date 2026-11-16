import { z } from 'zod'
import type { LiveContainerDetail } from '../../../../../../shared/schemas/live'
import { portainer } from '../../../../../adapters/portainer'
import { requireAnyPermission } from '../../../../../utils/auth'
import { connectionFor } from '../../../../../services/servers'
import { liveEndpoints, projectOfStack } from '../../../../../services/live'

defineRouteMeta({ openAPI: { tags: ['live'], summary: 'Détail en direct d\'un conteneur : état, santé, réseau, volumes, variables (noms seuls), métriques' } })

const params = z.object({ id: z.uuid(), cid: z.string().regex(/^[a-f0-9]{12,64}$/) })

export default defineEventHandler(async (event): Promise<LiveContainerDetail> => {
  const user = await requireAnyPermission(event, 'server:read')
  const { id, cid } = await getValidatedRouterParams(event, params.parse)
  const [row] = await liveEndpoints(user, id)
  if (!row) throw createError({ statusCode: 404, statusMessage: 'Endpoint introuvable' })
  const conn = await connectionFor(row.server)
  const p = portainer()
  const container = await p.inspectContainer(conn, row.ep.portainerEndpointId, cid)
  if (!container) throw createError({ statusCode: 404, statusMessage: 'Conteneur introuvable (supprimé entre-temps ?)' })
  const stats = container.state.running ? await p.containerStats(conn, row.ep.portainerEndpointId, cid).catch(() => null) : null
  return { container, stats, project: await projectOfStack(row.ep.id, container.labels['com.docker.compose.project'] ?? null), execSupported: row.server.transport === 'ssh' }
})
