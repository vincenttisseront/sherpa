import { z } from 'zod'
import { OLLAMA_FEATURE_KEYS } from '../../../../shared/schemas/ollama'
import { auditedAssist } from '../../../utils/ai-audit'
import { requireAnyPermission, requirePermission } from '../../../utils/auth'
import { requestProgress } from '../../../utils/progress'
import { readValidated } from '../../../utils/validation'
import { assistFor } from '../../../services/ai-registry'

defineRouteMeta({ openAPI: { tags: ['ollama'], summary: 'Fonction d\'assistance par Ollama (logs, diagnostic de déploiement, tech support, ressources, proxies, blocages Compose…) : droits de la ressource, secrets masqués avant envoi, rien de stocké' } })

const params = z.object({ feature: z.enum(OLLAMA_FEATURE_KEYS) })

export default defineEventHandler(async (event) => {
  const { feature } = await getValidatedRouterParams(event, params.parse)
  const spec = assistFor(feature)
  // Droit minimal d'abord (authentifie et écarte qui n'a la permission nulle part), puis droit exact sur la ressource résolue.
  const user = await requireAnyPermission(event, spec.permission)
  const input = await readValidated(event, spec.input)
  const target = await spec.resolve(input as never, user)
  await requirePermission(event, spec.permission, target.scope)
  return auditedAssist(event, user, { feature, ...target.audit, withQuestion: !!input.focus }, () => target.run(requestProgress(event)))
})
