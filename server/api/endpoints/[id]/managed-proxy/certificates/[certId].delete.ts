import { z } from 'zod'
import { audit } from '../../../../../utils/audit'
import { clientIp, requireAnyPermission, requirePermission } from '../../../../../utils/auth'
import { liveEndpoints } from '../../../../../services/live'
import { removeCertificate } from '../../../../../services/proxy-certificates'

defineRouteMeta({ openAPI: { tags: ['proxy'], summary: 'Supprime un certificat importé (clé chiffrée détruite) ; retiré de Traefik à la prochaine application' } })

export default defineEventHandler(async (event) => {
  const { id, certId } = await getValidatedRouterParams(event, z.object({ id: z.uuid(), certId: z.uuid() }).parse)
  const reader = await requireAnyPermission(event, 'server:read')
  const [row] = await liveEndpoints(reader, id)
  if (!row) throw createError({ statusCode: 404, statusMessage: 'Endpoint introuvable' })
  const user = await requirePermission(event, 'server:manage', { serverId: row.server.id })
  const r = await removeCertificate(row.ep.id, certId)
  await audit({ actorUserId: user.id, actorLabel: user.email, action: 'proxy.certificate.delete', targetType: 'server_endpoint', targetId: row.ep.id, serverId: row.server.id, outcome: 'success', ip: clientIp(event), details: { certificate: certId, domains: r.domains } })
  return { ok: true }
})
