import { ollamaTestInput } from '../../../../shared/schemas/ollama'
import { requirePermission } from '../../../utils/auth'
import { readValidated } from '../../../utils/validation'
import { testOllama } from '../../../services/ollama'

defineRouteMeta({ openAPI: { tags: ['admin'], summary: 'Teste la connexion à Ollama : version, modèles installés, présence du modèle configuré' } })

export default defineEventHandler(async (event) => {
  await requirePermission(event, 'policy:manage')
  return testOllama(await readValidated(event, ollamaTestInput.default({})))
})
