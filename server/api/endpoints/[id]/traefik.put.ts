import { and, eq } from 'drizzle-orm'
import { traefikConfigInput } from '../../../../shared/schemas/infra'
import { db, schema } from '../../../db/client'
import { audit } from '../../../utils/audit'
import { clientIp, requirePermission } from '../../../utils/auth'
import { idParam, readValidated, validationError } from '../../../utils/validation'
import { loadEndpointConfig } from '../../../services/endpoint-config'
import { upsertTraefikConfig, validateTraefik } from '../../../services/infra-config'
import { connectionFor, getEndpointOr404 } from '../../../services/servers'
import { portainer } from '../../../adapters/portainer'
import { invalidateTopology } from '../../../services/proxy'
import { invalidateProxyMap } from '../../../services/proxy-map'

defineRouteMeta({ openAPI: { tags: ['endpoints'], summary: 'Configuration Traefik et domaines autorisés de l\'endpoint' } })

export default defineEventHandler(async (event) => {
  const { id } = await getValidatedRouterParams(event, idParam.parse)
  const ep = await getEndpointOr404(id)
  const user = await requirePermission(event, 'domain:manage', { serverId: ep.serverId })
  const cfg = await readValidated(event, traefikConfigInput)

  const nets = await db().select({ name: schema.networks.name, policy: schema.networks.policy }).from(schema.networks)
    .where(and(eq(schema.networks.endpointId, id), eq(schema.networks.missing, false)))
  const errors = validateTraefik(cfg, nets.map(n => n.name))
  if (!errors.networkName && nets.find(n => n.name === cfg.networkName)?.policy !== 'allowed') errors.networkName = 'Le réseau du reverse proxy doit être autorisé'
  // nginx : le conteneur doit exister et être branché sur le réseau du proxy.
  if (cfg.provider !== 'traefik' && cfg.nginxContainer && !errors.nginxContainer) {
    const [server] = await db().select().from(schema.portainerServers).where(eq(schema.portainerServers.id, ep.serverId))
    const containers = server ? await portainer().listContainers(await connectionFor(server), ep.portainerEndpointId).catch(() => null) : null
    const c = containers?.find(x => x.names.includes(cfg.nginxContainer!))
    if (containers && !c) errors.nginxContainer = `Conteneur ${cfg.nginxContainer} introuvable sur cet endpoint`
    else if (c && !c.networks.includes(cfg.networkName)) errors.nginxContainer = `${cfg.nginxContainer} n'est pas branché sur le réseau ${cfg.networkName}`
  }
  if (Object.keys(errors).length) throw validationError(errors, 'Configuration du reverse proxy invalide')

  await db().transaction(tx => upsertTraefikConfig(tx, id, cfg))
  // Proxy déclaré : relu comme tel (onglet Proxy, page Reverse proxies).
  invalidateTopology(id)
  invalidateProxyMap(id)
  await audit({ actorUserId: user.id, actorLabel: user.email, action: 'traefik.update', targetType: 'server_endpoint', targetId: id, serverId: ep.serverId, outcome: 'success', ip: clientIp(event), details: { ...cfg } })
  return loadEndpointConfig(id)
})
