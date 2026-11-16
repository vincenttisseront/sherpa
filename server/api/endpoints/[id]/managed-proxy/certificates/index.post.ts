import { certificateImportInput } from '../../../../../../shared/schemas/managed-proxy'
import { audit } from '../../../../../utils/audit'
import { clientIp, requireAnyPermission, requirePermission } from '../../../../../utils/auth'
import { idParam, readValidated } from '../../../../../utils/validation'
import { liveEndpoints } from '../../../../../services/live'
import { importCertificate } from '../../../../../services/proxy-certificates'

defineRouteMeta({ openAPI: { tags: ['proxy'], summary: 'Importe un certificat (PEM, chaîne) et sa clé privée pour le Traefik géré : contrôlés, clé chiffrée ; en service à la prochaine application' } })

export default defineEventHandler(async (event) => {
  const { id } = await getValidatedRouterParams(event, idParam.parse)
  const reader = await requireAnyPermission(event, 'server:read')
  const [row] = await liveEndpoints(reader, id)
  if (!row) throw createError({ statusCode: 404, statusMessage: 'Endpoint introuvable' })
  const user = await requirePermission(event, 'server:manage', { serverId: row.server.id })
  const input = await readValidated(event, certificateImportInput)
  const r = await importCertificate(row.ep.id, input, user.id)
  // Jamais la clé : domaines, émetteur, empreinte et expiration seulement.
  await audit({ actorUserId: user.id, actorLabel: user.email, action: 'proxy.certificate.import', targetType: 'server_endpoint', targetId: row.ep.id, serverId: row.server.id, outcome: 'success', ip: clientIp(event), details: { domains: r.certificate.domains, issuer: r.certificate.issuer, notAfter: r.certificate.notAfter, fingerprint: r.certificate.fingerprint, isDefault: r.certificate.isDefault } })
  setResponseStatus(event, 201)
  return r
})
