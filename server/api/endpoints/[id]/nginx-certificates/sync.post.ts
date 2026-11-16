import { audit } from '../../../../utils/audit'
import { clientIp, requireAnyPermission, requirePermission } from '../../../../utils/auth'
import { idParam } from '../../../../utils/validation'
import { liveEndpoints } from '../../../../services/live'
import { syncNginxCertificates } from '../../../../services/nginx-certificates'

defineRouteMeta({ openAPI: { tags: ['proxy'], summary: 'nginx : obtient les certificats Let\'s Encrypt manquants ou à renouveler, dépose les certificats des domaines exposés dans le conteneur et recharge nginx' } })

export default defineEventHandler(async (event) => {
  const { id } = await getValidatedRouterParams(event, idParam.parse)
  const reader = await requireAnyPermission(event, 'server:read')
  const [row] = await liveEndpoints(reader, id)
  if (!row) throw createError({ statusCode: 404, statusMessage: 'Endpoint introuvable' })
  const user = await requirePermission(event, 'server:manage', { serverId: row.server.id })
  const results = await syncNginxCertificates(row.ep.id)
  if (!results.length) throw createError({ statusCode: 409, statusMessage: 'Aucun reverse proxy nginx avec un conteneur déclaré sur cet endpoint' })
  const failed = results.some(r => r.errors.length)
  await audit({ actorUserId: user.id, actorLabel: user.email, action: 'proxy.nginx.certificates.sync', targetType: 'server_endpoint', targetId: row.ep.id, serverId: row.server.id, outcome: failed ? 'failure' : 'success', ip: clientIp(event), details: { results: results.map(r => ({ container: r.container, pushed: r.pushed, issued: r.issued, errors: r.errors })) } })
  return { results }
})
