import { requirePermission } from '../../../utils/auth'
import { env } from '../../../utils/env'
import { retentionStatus } from '../../../worker/retention'

defineRouteMeta({ openAPI: { tags: ['admin'], summary: 'Rétention : volumes, éléments expirés, dernière purge' } })

export default defineEventHandler(async (event) => {
  await requirePermission(event, 'audit:read')
  return retentionStatus(env().RETENTION_DAYS)
})
