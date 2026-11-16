/**
 * Adaptateur des hôtes : la console joint directement l'agent Portainer de
 * chaque hôte (port 9001). Aucun serveur Portainer n'intervient.
 *
 * - Les opérations Docker passent par un transport signé (racine de l'agent,
 *   en-têtes X-PortainerAgent-*).
 * - Un agent = un hôte = un endpoint (identifiant 1).
 * - Les stacks sont des projets Compose déployés par la console elle-même
 *   (`docker compose` à travers l'agent) : une stack existe tant que des
 *   conteneurs portent son nom de projet et le label platform.managed.
 */
import { fetch } from 'undici'
import { agentHeaders } from './agent-signature'
import { type DockerTransport, type HttpAdapterOptions, agentFor, classify, createDockerOps } from './http'
import { HOST_ENDPOINT_ID, composeStackOps } from './stacks'
import type { PortainerAdapter, PortainerConnection } from './types'
import { PortainerError, isSupportedVersion } from './types'

export const AGENT_ENDPOINT_ID = HOST_ENDPOINT_ID
export { agentStackId } from './stacks'

export const agentTransport: DockerTransport = {
  label: 'L\'agent Portainer',
  authError: 'Signature refusée par l\'agent : vérifier AGENT_SECRET',
  target: async conn => ({ base: conn.url, dispatcher: agentFor(conn) }),
  dockerPrefix: () => '',
  headers: conn => agentHeaders(conn.token),
}

export function createAgentAdapter(opts: HttpAdapterOptions): PortainerAdapter {
  const base = createDockerOps(opts, agentTransport)
  const LONG_MS = Math.max(opts.timeoutMs, 10 * 60_000)

  async function raw(conn: PortainerConnection, path: string, signed = true) {
    try {
      const res = await fetch(`${conn.url}${path}`, {
        dispatcher: agentFor(conn),
        signal: AbortSignal.timeout(opts.timeoutMs),
        headers: { ...(signed ? agentHeaders(conn.token) : {}), Accept: 'application/json' },
      })
      if (res.status === 401 || res.status === 403) throw new PortainerError(agentTransport.authError, 'auth', res.status)
      if (!res.ok && res.status !== 204) throw new PortainerError(`L'agent a répondu ${res.status} sur ${path}`, 'http', res.status)
      return res
    }
    catch (err) {
      throw classify(err)
    }
  }

  return {
    ...base,
    ...composeStackOps(base, LONG_MS),

    async getVersion(conn) {
      // /ping n'est pas signé : la lecture de /info vérifie aussi le secret.
      const ping = await raw(conn, '/ping', false)
      const version = ping.headers.get('portainer-agent')
      if (!version) throw new PortainerError('Pas d\'agent Portainer à cette adresse', 'unsupported')
      await raw(conn, '/info')
      return { version, supported: isSupportedVersion(version) }
    },

    async listEndpoints(conn) {
      const info = await (await raw(conn, '/info')).json() as { Name?: string, Swarm?: { LocalNodeState?: string } }
      const swarm = info.Swarm?.LocalNodeState === 'active'
      return [{ id: AGENT_ENDPOINT_ID, name: info.Name || new URL(conn.url).hostname, kind: swarm ? 'docker_swarm' : 'docker_standalone', url: conn.url, online: true, rawType: 2 }]
    },
  }
}
