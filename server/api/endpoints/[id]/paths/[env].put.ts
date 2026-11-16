import { and, eq, ne } from 'drizzle-orm'
import { z } from 'zod'
import { environmentKey } from '../../../../../shared/schemas/common'
import { pathConfigInput } from '../../../../../shared/schemas/infra'
import { db, schema } from '../../../../db/client'
import { audit } from '../../../../utils/audit'
import { clientIp, requirePermission } from '../../../../utils/auth'
import { readValidated, validationError } from '../../../../utils/validation'
import { loadEndpointConfig } from '../../../../services/endpoint-config'
import { findCrossEnvironmentOverlaps, upsertPathConfig, validatePathConfig } from '../../../../services/infra-config'
import { environmentMaps, getEndpointOr404 } from '../../../../services/servers'
import { prepareEndpointDirectories } from '../../../../services/runner-admin'

defineRouteMeta({ openAPI: { tags: ['endpoints'], summary: 'Enregistre les chemins de travail d\'un endpoint pour un environnement' } })

const params = z.object({ id: z.uuid(), env: environmentKey })

export default defineEventHandler(async (event) => {
  const { id, env } = await getValidatedRouterParams(event, params.parse)
  const ep = await getEndpointOr404(id)
  const { idByKey } = await environmentMaps()
  const environmentId = idByKey.get(env)!
  const user = await requirePermission(event, 'path:manage', { serverId: ep.serverId, environmentId })
  const cfg = await readValidated(event, pathConfigInput)

  const linked = await db().$count(schema.endpointEnvironments, and(eq(schema.endpointEnvironments.endpointId, id), eq(schema.endpointEnvironments.environmentId, environmentId)))
  if (!linked) throw validationError({ environment: `L'endpoint n'est pas associé à l'environnement ${env}` })

  const r = validatePathConfig(cfg)
  if (!r.ok) throw validationError(r.errors, 'Chemins invalides')

  const others = await db().select().from(schema.pathConfigs).where(and(eq(schema.pathConfigs.endpointId, id), ne(schema.pathConfigs.environmentId, environmentId)))
  const { keyById } = await environmentMaps()
  const overlaps = findCrossEnvironmentOverlaps({ [env]: r.value, ...Object.fromEntries(others.map(o => [keyById.get(o.environmentId)!, o])) })
  if (overlaps[env]) throw validationError(overlaps[env], 'Chemins partagés avec un autre environnement')

  await db().transaction(tx => upsertPathConfig(tx, id, environmentId, r.value, user.id))
  await audit({ actorUserId: user.id, actorLabel: user.email, action: 'paths.update', targetType: 'server_endpoint', targetId: id, serverId: ep.serverId, environmentId, outcome: 'success', ip: clientIp(event), details: { ...r.value } })
  // Répertoires créés aussitôt (hôte joignable), sans action manuelle sur l'hôte.
  const directories = await prepareEndpointDirectories(id, environmentId)
  return { ...(await loadEndpointConfig(id)), directories }
})
