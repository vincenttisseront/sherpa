import { requirePermission } from '../../../utils/auth'
import { listDnsAccounts } from '../../../services/dns-accounts'

defineRouteMeta({ openAPI: { tags: ['admin'], summary: 'Comptes DNS du défi ACME DNS-01 (jamais leurs identifiants)' } })

export default defineEventHandler(async (event) => {
  await requirePermission(event, 'domain:manage')
  return listDnsAccounts()
})
