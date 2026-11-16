import { decisionInput } from '../../../../shared/schemas/deploy-gate'
import { requirePermission } from '../../../utils/auth'
import { deploymentScope } from '../../../services/deployments'
import { decide } from '../../../services/deploy-gate'
import { idParam, readValidated } from '../../../utils/validation'

defineRouteMeta({ openAPI: { tags: ['deployments'], summary: 'Valide ou refuse (autre personne que le demandeur, droit deployment:approve) ou annule un déploiement en attente ou planifié' } })

export default defineEventHandler(async (event) => {
  const { id } = await getValidatedRouterParams(event, idParam.parse)
  const { decision, comment } = await readValidated(event, decisionInput)
  const scope = await deploymentScope(id)
  const user = decision === 'cancel' ? await requirePermission(event, 'deployment:execute', scope) : await requirePermission(event, 'deployment:approve', scope)
  return decide(id, user, decision, comment ?? null)
})
