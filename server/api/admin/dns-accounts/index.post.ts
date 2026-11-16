import { dnsAccountInput } from '../../../../shared/schemas/dns'
import { audit } from '../../../utils/audit'
import { clientIp, requirePermission } from '../../../utils/auth'
import { readValidated } from '../../../utils/validation'
import { createDnsAccount } from '../../../services/dns-accounts'

defineRouteMeta({ openAPI: { tags: ['admin'], summary: 'Ajoute un compte DNS (identifiants contrôlés auprès du fournisseur puis chiffrés)' } })

export default defineEventHandler(async (event) => {
  const user = await requirePermission(event, 'domain:manage')
  const input = await readValidated(event, dnsAccountInput)
  const r = await createDnsAccount(input, user.id)
  // Jamais les identifiants : fournisseur et zones seulement.
  await audit({ actorUserId: user.id, actorLabel: user.email, action: 'dns_account.create', targetType: 'dns_account', targetId: r.account.id, outcome: 'success', ip: clientIp(event), details: { name: r.account.name, provider: r.account.provider, zones: r.account.zones, wildcard: r.account.wildcard } })
  setResponseStatus(event, 201)
  return r
})
