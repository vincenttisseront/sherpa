import { requirePermission } from '../../../../utils/auth'
import { idParam } from '../../../../utils/validation'
import { checkDnsAccount } from '../../../../services/dns-accounts'

defineRouteMeta({ openAPI: { tags: ['admin'], summary: 'Contrôle un compte DNS : accès à l\'API, zones visibles' } })

export default defineEventHandler(async (event) => {
  const { id } = await getValidatedRouterParams(event, idParam.parse)
  await requirePermission(event, 'domain:manage')
  return checkDnsAccount(id)
})
