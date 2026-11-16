import { metricRulesInput } from '../../../../shared/schemas/metrics'
import { getRules, setRules } from '../../../services/metrics'
import { audit } from '../../../utils/audit'
import { clientIp, requirePermission } from '../../../utils/auth'
import { readValidated } from '../../../utils/validation'

defineRouteMeta({ openAPI: { tags: ['admin'], summary: 'Remplace les règles d\'alerte de ressources (CPU, mémoire, redémarrages)' } })

export default defineEventHandler(async (event) => {
  const user = await requirePermission(event, 'notification:manage')
  const { rules } = await readValidated(event, metricRulesInput)
  const before = await getRules()
  await setRules(rules, user.id)
  await audit({ actorUserId: user.id, actorLabel: user.email, action: 'policy.metric_alerts', outcome: 'success', ip: clientIp(event), details: { before, after: rules } })
  return { rules }
})
