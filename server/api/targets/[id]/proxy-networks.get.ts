import { and, eq, isNull } from 'drizzle-orm'
import { db, schema } from '../../../db/client'
import { requirePermission } from '../../../utils/auth'
import { idParam } from '../../../utils/validation'
import { getTargetOr404, targetScope } from '../../../services/projects'

defineRouteMeta({ openAPI: { tags: ['targets'], summary: 'Réseaux utilisables par le reverse proxy pour cette cible (autorisés sur l\'endpoint)' } })

export default defineEventHandler(async (event) => {
  const { id } = await getValidatedRouterParams(event, idParam.parse)
  const t = await getTargetOr404(id)
  await requirePermission(event, 'project:read', targetScope(t))
  const nets = await db().select({ name: schema.networks.name, role: schema.networks.role }).from(schema.networks)
    .where(and(eq(schema.networks.endpointId, t.endpoint.id), eq(schema.networks.policy, 'allowed'), eq(schema.networks.missing, false)))
  const [tc] = await db().select({ networkName: schema.traefikConfigs.networkName }).from(schema.traefikConfigs)
    .where(and(eq(schema.traefikConfigs.endpointId, t.endpoint.id), isNull(schema.traefikConfigs.environmentId)))
  return { default: tc?.networkName ?? null, networks: nets.sort((a, b) => Number(b.role === 'traefik') - Number(a.role === 'traefik') || a.name.localeCompare(b.name)) }
})
