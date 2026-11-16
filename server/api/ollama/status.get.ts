import { requireAnyPermission } from '../../utils/auth'
import { ollamaStatus } from '../../services/ollama'

defineRouteMeta({ openAPI: { tags: ['logs'], summary: 'L\'analyse de logs par Ollama est-elle disponible ? (sans l\'adresse du serveur)' } })

export default defineEventHandler(async (event) => {
  await requireAnyPermission(event, 'logs:read')
  return ollamaStatus()
})
