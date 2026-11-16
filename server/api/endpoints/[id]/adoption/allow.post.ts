import { and, eq } from 'drizzle-orm'
import { adoptionAllowInput } from '../../../../../shared/schemas/adoption'
import { db, schema } from '../../../../db/client'
import { audit } from '../../../../utils/audit'
import { clientIp, requirePermission } from '../../../../utils/auth'
import { validateVolumeRulePath } from '../../../../utils/bind-guard'
import { normalizeAbsolute } from '../../../../utils/path-guard'
import { idParam, readValidated, validationError } from '../../../../utils/validation'
import { validatePortRule } from '../../../../services/infra-config'
import { environmentMaps, getEndpointOr404 } from '../../../../services/servers'

defineRouteMeta({ openAPI: { tags: ['adoption'], summary: 'Lève un point bloquant de la reprise : ajoute une règle de port autorisé ou un chemin bind à la liste blanche de l\'endpoint' } })

/** Ajoute une seule règle (les autres sont conservées), avec les mêmes contrôles que l'édition des listes. */
export default defineEventHandler(async (event) => {
  const { id } = await getValidatedRouterParams(event, idParam.parse)
  const ep = await getEndpointOr404(id)
  const input = await readValidated(event, adoptionAllowInput)
  const user = await requirePermission(event, input.kind === 'port' ? 'port:manage' : 'volume:manage', { serverId: ep.serverId })
  const { idByKey } = await environmentMaps()
  const environmentId = input.environmentKey ? idByKey.get(input.environmentKey) ?? null : null
  if (input.environmentKey && !environmentId) throw validationError({ environmentKey: 'Environnement inconnu' })

  if (input.kind === 'port') {
    const rule = { portFrom: input.port, portTo: input.port, protocol: input.protocol, policy: 'allowed' as const, environmentKey: input.environmentKey, description: input.description }
    const msg = validatePortRule(rule)
    if (msg) throw validationError({ port: msg })
    await db().insert(schema.portRules).values({ endpointId: id, environmentId, portFrom: input.port, portTo: input.port, protocol: input.protocol, policy: 'allowed', description: input.description })
    await audit({ actorUserId: user.id, actorLabel: user.email, action: 'port_rules.allow', targetType: 'server_endpoint', targetId: id, serverId: ep.serverId, outcome: 'success', ip: clientIp(event), details: { port: input.port, protocol: input.protocol, environment: input.environmentKey, description: input.description, via: 'adoption' } })
    return { ok: true }
  }

  const configs = await db().select().from(schema.pathConfigs).where(eq(schema.pathConfigs.endpointId, id))
  const msg = validateVolumeRulePath(input.hostPath, configs.flatMap(c => [c.workingRoot, c.buildRoot, c.tmpRoot]))
  if (msg) throw validationError({ hostPath: msg })
  const hostPath = normalizeAbsolute(input.hostPath)
  const existing = await db().select({ id: schema.volumeRules.id, mode: schema.volumeRules.mode }).from(schema.volumeRules)
    .where(and(eq(schema.volumeRules.endpointId, id), eq(schema.volumeRules.hostPath, hostPath)))
  const same = existing.find(() => true)
  if (same) {
    // Même chemin déjà présent (autre portée ou lecture seule) : réactivé, et élargi en écriture si demandé.
    await db().update(schema.volumeRules).set({ enabled: true, ...(input.mode === 'rw' ? { mode: 'rw' as const } : {}), environmentId: environmentId ?? null }).where(eq(schema.volumeRules.id, same.id))
  }
  else {
    await db().insert(schema.volumeRules).values({ endpointId: id, hostPath, mode: input.mode, environmentId, description: input.description, enabled: true, createdBy: user.id })
  }
  await audit({ actorUserId: user.id, actorLabel: user.email, action: 'volume_rules.allow', targetType: 'server_endpoint', targetId: id, serverId: ep.serverId, outcome: 'success', ip: clientIp(event), details: { hostPath, mode: input.mode, environment: input.environmentKey, description: input.description, via: 'adoption' } })
  return { ok: true }
})
