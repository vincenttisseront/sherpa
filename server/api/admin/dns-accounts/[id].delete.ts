import { audit } from '../../../utils/audit'
import { clientIp, requirePermission } from '../../../utils/auth'
import { idParam } from '../../../utils/validation'
import { removeDnsAccount } from '../../../services/dns-accounts'

defineRouteMeta({ openAPI: { tags: ['admin'], summary: 'Supprime un compte DNS et ses identifiants' } })

export default defineEventHandler(async (event) => {
  const { id } = await getValidatedRouterParams(event, idParam.parse)
  const user = await requirePermission(event, 'domain:manage')
  const r = await removeDnsAccount(id)
  await audit({ actorUserId: user.id, actorLabel: user.email, action: 'dns_account.delete', targetType: 'dns_account', targetId: id, outcome: 'success', ip: clientIp(event), details: r })
  setResponseStatus(event, 204)
  return null
})
