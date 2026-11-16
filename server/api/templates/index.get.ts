import { listTemplates } from '../../services/templates'
import { requireAnyPermission } from '../../utils/auth'

defineRouteMeta({ openAPI: { tags: ['templates'], summary: 'Modèles de Compose (fournis et enregistrés), avec leurs variables' } })

export default defineEventHandler(async (event) => {
  await requireAnyPermission(event, 'source:import')
  return { templates: await listTemplates() }
})
