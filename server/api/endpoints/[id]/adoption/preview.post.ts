import { adoptionInput } from '../../../../../shared/schemas/adoption'
import { requireAnyPermission, requirePermission } from '../../../../utils/auth'
import { requestProgress } from '../../../../utils/progress'
import { idParam, readValidated } from '../../../../utils/validation'
import { liveEndpoints } from '../../../../services/live'
import { previewAdoption } from '../../../../services/adoption'

defineRouteMeta({ openAPI: { tags: ['adoption'], summary: 'Aperçu de la reprise d\'une stack existante : Compose converti, expositions, variables (noms), analyse. Rien n\'est enregistré.' } })

export default defineEventHandler(async (event) => {
  const { id } = await getValidatedRouterParams(event, idParam.parse)
  const user = await requireAnyPermission(event, 'project:create')
  const [row] = await liveEndpoints(user, id)
  if (!row) throw createError({ statusCode: 404, statusMessage: 'Endpoint introuvable' })
  await requirePermission(event, 'server:manage', { serverId: row.server.id })
  const input = await readValidated(event, adoptionInput)
  return previewAdoption(row, input, requestProgress(event))
})
