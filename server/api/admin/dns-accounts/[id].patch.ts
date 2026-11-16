import { dnsAccountPatch } from '../../../../shared/schemas/dns'
import { audit } from '../../../utils/audit'
import { clientIp, requirePermission } from '../../../utils/auth'
import { idParam, readValidated } from '../../../utils/validation'
import { updateDnsAccount } from '../../../services/dns-accounts'

defineRouteMeta({ openAPI: { tags: ['admin'], summary: 'Modifie un compte DNS (nom, zones, certificats génériques, identifiants remplacés)' } })

export default defineEventHandler(async (event) => {
  const { id } = await getValidatedRouterParams(event, idParam.parse)
  const user = await requirePermission(event, 'domain:manage')
  const patch = await readValidated(event, dnsAccountPatch)
  const account = await updateDnsAccount(id, patch)
  await audit({ actorUserId: user.id, actorLabel: user.email, action: 'dns_account.update', targetType: 'dns_account', targetId: id, outcome: 'success', ip: clientIp(event), details: { name: account.name, zones: account.zones, wildcard: account.wildcard, credentialsReplaced: !!patch.credentials } })
  return account
})
