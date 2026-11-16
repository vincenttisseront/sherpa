import type { GateInfoDto } from '../../../../shared/schemas/deploy-gate'
import { requirePermission } from '../../../utils/auth'
import { idParam } from '../../../utils/validation'
import { gateInfo } from '../../../services/deploy-gate'
import { getTargetOr404, targetScope } from '../../../services/projects'

defineRouteMeta({ openAPI: { tags: ['targets'], summary: 'Porte de déploiement de la cible : validation requise, fenêtres, ouverture actuelle et prochaine' } })

export default defineEventHandler(async (event): Promise<GateInfoDto> => {
  const { id } = await getValidatedRouterParams(event, idParam.parse)
  const t = await getTargetOr404(id)
  await requirePermission(event, 'deployment:read', targetScope(t))
  return gateInfo(t.env.id)
})
