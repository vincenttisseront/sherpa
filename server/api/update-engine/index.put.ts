import { updateEngineInput } from '../../../shared/schemas/update-engine'
import { requirePermission } from '../../utils/auth'
import { readValidated } from '../../utils/validation'
import { setUpdateEngine } from '../../services/update-engine'

defineRouteMeta({ openAPI: { tags: ['watchtower'], summary: 'Choisit l\'image du moteur de mise à jour (dépôt maintenu du catalogue, version existante, figée par empreinte)' } })

export default defineEventHandler(async (event) => {
  const user = await requirePermission(event, 'policy:manage')
  return setUpdateEngine(await readValidated(event, updateEngineInput), user)
})
