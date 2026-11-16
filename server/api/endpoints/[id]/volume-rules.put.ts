import { eq } from 'drizzle-orm'
import { z } from 'zod'
import { volumeRuleInput } from '../../../../shared/schemas/infra'
import { db, schema } from '../../../db/client'
import { audit } from '../../../utils/audit'
import { clientIp, requirePermission } from '../../../utils/auth'
import { validateVolumeRulePath } from '../../../utils/bind-guard'
import { normalizeAbsolute } from '../../../utils/path-guard'
import { idParam, readValidated, validationError } from '../../../utils/validation'
import { environmentMaps, getEndpointOr404 } from '../../../services/servers'

defineRouteMeta({ openAPI: { tags: ['endpoints'], summary: 'Remplace la liste blanche des chemins bind de l\'endpoint' } })

export default defineEventHandler(async (event) => {
  const { id } = await getValidatedRouterParams(event, idParam.parse)
  const ep = await getEndpointOr404(id)
  const user = await requirePermission(event, 'volume:manage', { serverId: ep.serverId })
  const rules = await readValidated(event, z.array(volumeRuleInput).max(200))

  const configs = await db().select().from(schema.pathConfigs).where(eq(schema.pathConfigs.endpointId, id))
  const workingRoots = configs.flatMap(c => [c.workingRoot, c.buildRoot, c.tmpRoot])
  const errors: Record<string, string> = {}
  const seen = new Set<string>()
  rules.forEach((r, i) => {
    const msg = validateVolumeRulePath(r.hostPath, workingRoots)
    if (msg) errors[`${i}.hostPath`] = msg
    if (msg) return
    const key = `${normalizeAbsolute(r.hostPath)}|${r.environmentKey ?? ''}`
    if (seen.has(key)) errors[`${i}.hostPath`] = 'Règle en double'
    seen.add(key)
  })
  if (Object.keys(errors).length) throw validationError(errors, 'Liste blanche invalide')

  const { idByKey } = await environmentMaps()
  await db().transaction(async (tx) => {
    await tx.delete(schema.volumeRules).where(eq(schema.volumeRules.endpointId, id))
    if (rules.length) {
      await tx.insert(schema.volumeRules).values(rules.map(r => ({
        endpointId: id,
        hostPath: normalizeAbsolute(r.hostPath),
        mode: r.mode,
        environmentId: r.environmentKey ? idByKey.get(r.environmentKey)! : null,
        description: r.description,
        enabled: r.enabled,
        createdBy: user.id,
      })))
    }
  })
  await audit({ actorUserId: user.id, actorLabel: user.email, action: 'volume_rules.update', targetType: 'server_endpoint', targetId: id, serverId: ep.serverId, outcome: 'success', ip: clientIp(event), details: { rules } })
  return rules.map(r => ({ ...r, hostPath: normalizeAbsolute(r.hostPath) }))
})
