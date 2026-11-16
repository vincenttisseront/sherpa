/**
 * Opérations sur les serveurs (hôtes joints par leur agent Portainer) : connexion (secret
 * déchiffré à la volée, jamais conservé), contrôle de santé, re-découverte,
 * lecture du détail.
 */
import { emitNotification } from './notifications'
import { type Progress, noProgress } from '../utils/progress'
import { asc, eq, inArray, sql } from 'drizzle-orm'
import { createError } from 'h3'
import type { EnvironmentDto } from '../../shared/schemas/environments'
import type { DiscoveryReport, EndpointDto, ServerConnectionInput, ServerDetailDto, ServerStatus, SshCredentialsInput } from '../../shared/schemas/servers'
import type { PortainerConnection } from '../adapters/portainer'
import { PortainerError, portainer } from '../adapters/portainer'
import { db, schema } from '../db/client'
import { audit } from '../utils/audit'
import { decryptSecret } from '../utils/crypto'
import { redactPatterns } from '../utils/redact'
import { discoverServer, syncInventory } from './discovery'

export type ServerRow = typeof schema.portainerServers.$inferSelect

export async function getServerOr404(id: string): Promise<ServerRow> {
  const [row] = await db().select().from(schema.portainerServers).where(eq(schema.portainerServers.id, id))
  if (!row) throw createError({ statusCode: 404, statusMessage: 'Serveur introuvable' })
  return row
}

/** Secret SSH chiffré : mot de passe, ou clé privée et phrase de passe facultative. */
export interface SshSecret { password?: string, privateKey?: string, passphrase?: string }

export const encodeSshSecret = (s: SshSecret) => JSON.stringify(s)

export function decodeSshSecret(plain: string): SshSecret {
  const v = JSON.parse(plain) as SshSecret
  return { password: v.password, privateKey: v.privateKey, passphrase: v.passphrase }
}

/** Connexion SSH à partir de ses paramètres (assistant, test avant enregistrement). */
export function sshConnection(p: { host: string, port: number, username: string, hostKey: string | null, dockerSocket: string }, secret: SshSecret): PortainerConnection {
  return {
    transport: 'ssh',
    url: `ssh://${p.username}@${p.host}:${p.port}`,
    token: '',
    tlsVerify: true,
    ssh: { host: p.host, port: p.port, username: p.username, hostKey: p.hostKey, dockerSocket: p.dockerSocket, ...secret },
  }
}

/** Connexion à partir de la saisie (assistant, test) : agent ou SSH. */
export function connectionFromInput(input: ServerConnectionInput): PortainerConnection {
  if (input.transport === 'ssh') return sshConnection(input, sshSecretFromInput(input))
  return { transport: 'agent', url: input.url, token: input.token, tlsVerify: input.tlsVerify, caCertPem: input.caCertPem }
}

export function sshSecretFromInput(input: SshCredentialsInput): SshSecret {
  return input.auth === 'key' ? { privateKey: input.privateKey, ...(input.passphrase ? { passphrase: input.passphrase } : {}) } : { password: input.password }
}

/** Secret à chiffrer : AGENT_SECRET, ou identifiants SSH (JSON). */
export function secretFromInput(input: ServerConnectionInput): string {
  return input.transport === 'ssh' ? encodeSshSecret(sshSecretFromInput(input)) : input.token
}

/** Libellé de l'adresse (audit, affichage) : jamais de secret. */
export function connectionLabel(input: ServerConnectionInput): string {
  return input.transport === 'ssh' ? `ssh://${input.username}@${input.host}:${input.port}` : input.url
}

/** Colonnes du serveur issues de la saisie de connexion. */
export function serverColumnsFromInput(input: ServerConnectionInput) {
  if (input.transport === 'ssh') {
    return {
      transport: 'ssh' as const,
      url: connectionLabel(input),
      tlsVerify: true,
      caCertPem: null,
      sshHost: input.host,
      sshPort: input.port,
      sshUser: input.username,
      sshAuth: input.auth,
      sshHostKey: input.hostKey,
      dockerSocket: input.dockerSocket,
    }
  }
  return { transport: 'agent' as const, url: input.url, tlsVerify: input.tlsVerify, caCertPem: input.caCertPem ?? null }
}

export async function connectionFor(server: ServerRow): Promise<PortainerConnection> {
  const [secret] = await db().select({ envelope: schema.secrets.envelope }).from(schema.secrets).where(eq(schema.secrets.id, server.tokenSecretId))
  if (!secret) throw new Error(`Secret du serveur ${server.id} introuvable`)
  if (server.transport === 'ssh') {
    if (!server.sshHost || !server.sshUser) throw new Error(`Paramètres SSH du serveur ${server.id} incomplets`)
    return sshConnection({ host: server.sshHost, port: server.sshPort ?? 22, username: server.sshUser, hostKey: server.sshHostKey, dockerSocket: server.dockerSocket }, decodeSshSecret(decryptSecret(secret.envelope)))
  }
  return { transport: 'agent', url: server.url, token: decryptSecret(secret.envelope), tlsVerify: server.tlsVerify, caCertPem: server.caCertPem }
}

export async function environmentMaps() {
  const envs = await db().select().from(schema.environments).orderBy(asc(schema.environments.sortOrder))
  return {
    envs,
    idByKey: new Map(envs.map(e => [e.key, e.id])),
    keyById: new Map(envs.map(e => [e.id, e.key])),
  }
}

/** Message d'erreur exploitable et sans secret. */
export function portainerErrorMessage(err: unknown): string {
  if (err instanceof PortainerError) return err.message
  return redactPatterns(err instanceof Error ? err.message : String(err)).slice(0, 500)
}

/**
 * Contrôle de santé (§5.2 « date du dernier contrôle / dernier message d'erreur ») :
 * - offline  : agent injoignable ou secret refusé ;
 * - degraded : l'agent répond mais un endpoint activé est hors ligne ou disparu ;
 * - online   : sinon.
 */
export async function checkServerHealth(server: ServerRow): Promise<{ status: ServerStatus, error: string | null }> {
  let status: ServerStatus
  let error: string | null = null
  try {
    const conn = await connectionFor(server)
    const version = await portainer().getVersion(conn)
    const remote = await portainer().listEndpoints(conn)
    const onlineById = new Map(remote.map(e => [e.id, e.online]))

    const local = await db().select().from(schema.serverEndpoints).where(eq(schema.serverEndpoints.serverId, server.id))
    for (const ep of local) {
      const online = onlineById.get(ep.portainerEndpointId) ?? false
      if (online !== ep.online) await db().update(schema.serverEndpoints).set({ online }).where(eq(schema.serverEndpoints.id, ep.id))
    }
    const broken = local.filter(ep => ep.enabled && !onlineById.get(ep.portainerEndpointId))
    status = broken.length ? 'degraded' : 'online'
    if (broken.length) error = `Endpoint(s) indisponible(s) : ${broken.map(b => b.name).join(', ')}`
    if (!version.supported) {
      status = 'degraded'
      error = `Version ${version.version} non supportée`
    }
    await db().update(schema.portainerServers).set({ detectedVersion: version.version }).where(eq(schema.portainerServers.id, server.id))
  }
  catch (err) {
    status = 'offline'
    error = portainerErrorMessage(err)
  }

  await db().update(schema.portainerServers)
    .set({ status, lastError: error, lastCheckedAt: new Date() })
    .where(eq(schema.portainerServers.id, server.id))

  if (status !== server.status) {
    await audit({
      actorLabel: 'system',
      action: 'server.status_changed',
      targetType: 'portainer_server',
      targetId: server.id,
      serverId: server.id,
      outcome: status === 'online' ? 'success' : 'failure',
      details: { from: server.status, to: status, error },
    })
    if (status === 'offline') {
      await emitNotification({
        event: 'server.unavailable', severity: 'error', title: `${server.transport === 'ssh' ? 'Hôte SSH' : 'Agent'} indisponible : ${server.name}`,
        summary: error ?? 'Le serveur ne répond plus.',
        facts: [{ label: 'Serveur', value: server.name }, { label: 'URL', value: server.url }, { label: 'Statut précédent', value: server.status }],
        path: `/servers/${server.id}`, serverId: server.id,
      })
    }
  }
  return { status, error }
}

export async function rediscover(server: ServerRow, progress: Progress = noProgress): Promise<DiscoveryReport> {
  const conn = await connectionFor(server)
  const preview = await discoverServer(portainer(), conn, progress)
  await progress.step('Enregistrement de l\'inventaire (endpoints, réseaux, volumes)')
  const { idByKey } = await environmentMaps()
  const { report } = await db().transaction(tx => syncInventory(tx, server.id, preview, new Map(), idByKey))
  return report
}

export async function loadServerDetail(id: string): Promise<ServerDetailDto> {
  const s = await getServerOr404(id)
  const endpoints = await db().select().from(schema.serverEndpoints)
    .where(eq(schema.serverEndpoints.serverId, id))
    .orderBy(asc(schema.serverEndpoints.portainerEndpointId))
  const ids = endpoints.map(e => e.id)

  const links = ids.length
    ? await db().select({ endpointId: schema.endpointEnvironments.endpointId, id: schema.environments.id, key: schema.environments.key, name: schema.environments.name, isProduction: schema.environments.isProduction })
      .from(schema.endpointEnvironments)
      .innerJoin(schema.environments, eq(schema.environments.id, schema.endpointEnvironments.environmentId))
      .where(inArray(schema.endpointEnvironments.endpointId, ids))
      .orderBy(asc(schema.environments.sortOrder))
    : []

  const netStats = ids.length
    ? await db().select({
        endpointId: schema.networks.endpointId,
        total: sql<number>`count(*) filter (where not ${schema.networks.missing})::int`,
        unreviewed: sql<number>`count(*) filter (where ${schema.networks.policy} = 'unreviewed' and not ${schema.networks.missing})::int`,
      }).from(schema.networks).where(inArray(schema.networks.endpointId, ids)).groupBy(schema.networks.endpointId)
    : []
  const volStats = ids.length
    ? await db().select({ endpointId: schema.dockerVolumes.endpointId, total: sql<number>`count(*) filter (where not ${schema.dockerVolumes.missing})::int` })
      .from(schema.dockerVolumes).where(inArray(schema.dockerVolumes.endpointId, ids)).groupBy(schema.dockerVolumes.endpointId)
    : []

  const endpointDtos: EndpointDto[] = endpoints.map(e => ({
    id: e.id,
    portainerEndpointId: e.portainerEndpointId,
    name: e.name,
    type: e.type,
    url: e.url,
    online: e.online,
    enabled: e.enabled,
    missing: e.missing,
    environments: links.filter(l => l.endpointId === e.id).map(({ endpointId: _, ...env }): EnvironmentDto => env),
    inventory: e.inventory,
    discoveredAt: e.discoveredAt.toISOString(),
    networkCount: netStats.find(n => n.endpointId === e.id)?.total ?? 0,
    unreviewedNetworks: netStats.find(n => n.endpointId === e.id)?.unreviewed ?? 0,
    volumeCount: volStats.find(v => v.endpointId === e.id)?.total ?? 0,
  }))

  return {
    id: s.id,
    name: s.name,
    description: s.description,
    transport: s.transport,
    url: s.url,
    tlsVerify: s.tlsVerify,
    caCertPem: s.caCertPem,
    ssh: s.transport === 'ssh' && s.sshHost
      ? { host: s.sshHost, port: s.sshPort ?? 22, username: s.sshUser ?? '', auth: s.sshAuth, hostKey: s.sshHostKey, hostKeyType: s.sshHostKeyType, dockerSocket: s.dockerSocket }
      : null,
    detectedVersion: s.detectedVersion,
    status: s.status,
    tags: s.tags,
    capabilities: s.capabilities,
    endpointCount: endpoints.filter(e => !e.missing).length,
    lastCheckedAt: s.lastCheckedAt?.toISOString() ?? null,
    lastDiscoveryAt: s.lastDiscoveryAt?.toISOString() ?? null,
    lastError: s.lastError,
    createdAt: s.createdAt.toISOString(),
    updatedAt: s.updatedAt.toISOString(),
    endpoints: endpointDtos,
  }
}

/** Charge un endpoint et son serveur, pour les routes /api/endpoints/:id. */
export async function getEndpointOr404(id: string) {
  const [row] = await db().select().from(schema.serverEndpoints).where(eq(schema.serverEndpoints.id, id))
  if (!row) throw createError({ statusCode: 404, statusMessage: 'Endpoint introuvable' })
  return row
}
