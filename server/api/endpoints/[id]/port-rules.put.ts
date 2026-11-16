import { z } from 'zod'
import { portRuleInput } from '../../../../shared/schemas/infra'
import { db } from '../../../db/client'
import { audit } from '../../../utils/audit'
import { clientIp, requirePermission } from '../../../utils/auth'
import { idParam, readValidated, validationError } from '../../../utils/validation'
import { loadEndpointConfig } from '../../../services/endpoint-config'
import { replacePortRules, validatePortRule } from '../../../services/infra-config'
import { environmentMaps, getEndpointOr404 } from '../../../services/servers'

defineRouteMeta({ openAPI: { tags: ['endpoints'], summary: 'Remplace les règles de ports d\'un endpoint' } })

export default defineEventHandler(async (event) => {
  const { id } = await getValidatedRouterParams(event, idParam.parse)
  const ep = await getEndpointOr404(id)
  const user = await requirePermission(event, 'port:manage', { serverId: ep.serverId })
  const rules = await readValidated(event, z.array(portRuleInput).max(200))

  const errors = Object.fromEntries(rules.map((r, i) => [`${i}`, validatePortRule(r)]).filter(([, m]) => m))
  if (Object.keys(errors).length) throw validationError(errors as Record<string, string>, 'Règles de ports invalides')

  const { idByKey } = await environmentMaps()
  await db().transaction(tx => replacePortRules(tx, id, rules, idByKey))
  await audit({ actorUserId: user.id, actorLabel: user.email, action: 'port_rules.update', targetType: 'server_endpoint', targetId: id, serverId: ep.serverId, outcome: 'success', ip: clientIp(event), details: { rules } })
  return loadEndpointConfig(id)
})
