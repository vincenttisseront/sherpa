import { accessLogQuery } from '../../../../../../shared/schemas/access-logs'
import { requireAnyPermission, requirePermission } from '../../../../../utils/auth'
import { idParam } from '../../../../../utils/validation'
import { readAccessLogs } from '../../../../../services/access-logs'
import { liveEndpoints } from '../../../../../services/live'
import { endpointTopology } from '../../../../../services/proxy'

defineRouteMeta({ openAPI: { tags: ['proxy'], summary: 'Logs d\'accès d\'un reverse proxy nginx : dernières requêtes analysées (domaine, statut, durée), statistiques et erreurs' } })

export default defineEventHandler(async (event) => {
  const { id } = await getValidatedRouterParams(event, idParam.parse)
  const cid = getRouterParam(event, 'cid') ?? ''
  if (!/^[0-9a-f]{12,64}$/.test(cid)) throw createError({ statusCode: 400, statusMessage: 'Identifiant de conteneur invalide' })
  const reader = await requireAnyPermission(event, 'server:read')
  const [row] = await liveEndpoints(reader, id)
  if (!row) throw createError({ statusCode: 404, statusMessage: 'Endpoint introuvable' })
  await requirePermission(event, 'logs:read', { serverId: row.server.id })
  const q = await getValidatedQuery(event, accessLogQuery.parse)
  // Seuls les proxies détectés se lisent ici (pas n'importe quel conteneur).
  const proxy = (await endpointTopology(row)).proxies.find(p => p.container.id === cid || p.container.id.startsWith(cid))
  if (!proxy) throw createError({ statusCode: 404, statusMessage: 'Reverse proxy introuvable sur cet endpoint' })
  return readAccessLogs(row, proxy.container.id, q, { managedNginx: proxy.nginx?.managed?.provider === 'nginx' })
})
