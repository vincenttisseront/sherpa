import { listPolicies } from '../../../services/deploy-gate'
import { requirePermission } from '../../../utils/auth'

defineRouteMeta({ openAPI: { tags: ['admin'], summary: 'Politique de déploiement de chaque environnement : validation par une autre personne, fenêtres de déploiement' } })

export default defineEventHandler(async (event) => {
  await requirePermission(event, 'policy:manage')
  return { policies: await listPolicies() }
})
