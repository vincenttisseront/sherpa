import type { AddressPlanDto } from '../../../../shared/schemas/address-plan'
import { requirePermission } from '../../../utils/auth'
import { idParam } from '../../../utils/validation'
import { addressPlan } from '../../../services/address-plan'
import { getEndpointOr404 } from '../../../services/servers'

defineRouteMeta({ openAPI: { tags: ['endpoints'], summary: 'Plan d\'adressage : réseaux Docker de l\'hôte, sous-réseaux, propriétaires, problèmes et possibilité de déplacement' } })

export default defineEventHandler(async (event): Promise<AddressPlanDto> => {
  const { id } = await getValidatedRouterParams(event, idParam.parse)
  const ep = await getEndpointOr404(id)
  await requirePermission(event, 'server:read', { serverId: ep.serverId })
  return addressPlan(id)
})
