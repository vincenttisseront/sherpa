import { auditListQuery } from '../../../shared/schemas/lists'
import { canOn, requireAnyPermission } from '../../utils/auth'
import { tableResponse } from '../../utils/table'
import { visibleProjectIds } from '../../services/access'
import { AUDIT_CSV, listAudit } from '../../services/lists'

defineRouteMeta({ openAPI: { tags: ['audit'], summary: 'Journal d\'audit (six mois), filtres combinables, export CSV' } })

export default defineEventHandler(async (event) => {
  const user = await requireAnyPermission(event, 'audit:read')
  const visible = canOn(user, 'audit:read', {}) ? null : await visibleProjectIds(user, 'audit:read')
  const q = await getValidatedQuery(event, auditListQuery.parse)
  return tableResponse(event, q, x => listAudit(x, visible), { name: 'audit', columns: AUDIT_CSV, user })
})
