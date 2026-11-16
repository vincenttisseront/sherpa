import { z } from 'zod'
import { audit } from '../../../../../utils/audit'
import { clientIp, requireAnyPermission, requirePermission } from '../../../../../utils/auth'
import { readValidated } from '../../../../../utils/validation'
import { liveEndpoints } from '../../../../../services/live'
import { setDefaultCertificate } from '../../../../../services/proxy-certificates'

defineRouteMeta({ openAPI: { tags: ['proxy'], summary: 'Désigne (ou retire) le certificat importé servi par défaut' } })

export default defineEventHandler(async (event) => {
  const { id, certId } = await getValidatedRouterParams(event, z.object({ id: z.uuid(), certId: z.uuid() }).parse)
  const reader = await requireAnyPermission(event, 'server:read')
  const [row] = await liveEndpoints(reader, id)
  if (!row) throw createError({ statusCode: 404, statusMessage: 'Endpoint introuvable' })
  const user = await requirePermission(event, 'server:manage', { serverId: row.server.id })
  const { isDefault } = await readValidated(event, z.object({ isDefault: z.boolean() }))
  await setDefaultCertificate(row.ep.id, certId, isDefault)
  await audit({ actorUserId: user.id, actorLabel: user.email, action: 'proxy.certificate.default', targetType: 'server_endpoint', targetId: row.ep.id, serverId: row.server.id, outcome: 'success', ip: clientIp(event), details: { certificate: certId, isDefault } })
  return { ok: true }
})
