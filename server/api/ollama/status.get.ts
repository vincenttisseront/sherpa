import { requireUser } from '../../utils/auth'
import { ollamaStatus } from '../../services/ollama'

defineRouteMeta({ openAPI: { tags: ['ollama'], summary: 'Les fonctions d\'assistance par Ollama sont-elles disponibles ? (activées, modèle, fonctions cochées ; sans l\'adresse du serveur). Ouvert à tout compte connecté : le droit exact est contrôlé par chaque fonction.' } })

export default defineEventHandler((event) => {
  requireUser(event)
  return ollamaStatus()
})
