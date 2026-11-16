import { requireAnyPermission } from '../../utils/auth'
import { applyUpdateEngine } from '../../services/update-engine'

defineRouteMeta({ openAPI: { tags: ['watchtower'], summary: 'Redéploie les cibles dont le Watchtower n\'utilise pas l\'image choisie (droits vérifiés par cible)' } })

export default defineEventHandler(async (event) => {
  const user = await requireAnyPermission(event, 'deployment:execute')
  return applyUpdateEngine(user)
})
