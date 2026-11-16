import { requirePermission } from '../../../utils/auth'
import { ollamaSettingsDto } from '../../../services/ollama'

defineRouteMeta({ openAPI: { tags: ['admin'], summary: 'Réglages du connecteur Ollama (analyse de logs) ; le jeton n\'est jamais renvoyé' } })

export default defineEventHandler(async (event) => {
  await requirePermission(event, 'policy:manage')
  return ollamaSettingsDto()
})
