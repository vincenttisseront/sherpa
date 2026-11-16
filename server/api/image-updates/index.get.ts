import { imageUpdateListQuery } from '../../../shared/schemas/lists'
import { requireAnyPermission } from '../../utils/auth'
import { tableResponse } from '../../utils/table'
import { visibleTargetIds } from '../../services/access'
import { IMAGE_UPDATE_CSV, listImageUpdates } from '../../services/lists'

defineRouteMeta({ openAPI: { tags: ['watchtower'], summary: 'Historique des images (Watchtower, changements hors plateforme), export CSV' } })

export default defineEventHandler(async (event) => {
  const user = await requireAnyPermission(event, 'deployment:read')
  const visible = await visibleTargetIds(user, 'deployment:read')
  const q = await getValidatedQuery(event, imageUpdateListQuery.parse)
  return tableResponse(event, q, x => listImageUpdates(x, visible), { name: 'images', columns: IMAGE_UPDATE_CSV, user })
})
