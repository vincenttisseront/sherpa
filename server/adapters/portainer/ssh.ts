/**
 * Adaptateur des hôtes joints en SSH (mot de passe ou clé), sans agent :
 * mêmes opérations que l'agent Portainer. L'API Docker passe par le relais
 * local de la session SSH vers le socket Docker de l'hôte ; les stacks sont les
 * mêmes projets Compose, déployés par la console à travers ce relais.
 */
import { Agent, fetch } from 'undici'
import { sshDockerSocket } from '../ssh/session'
import { type DockerTransport, type HttpAdapterOptions, createDockerOps } from './http'
import { HOST_ENDPOINT_ID, composeStackOps } from './stacks'
import type { PortainerAdapter, PortainerConnection } from './types'
import { PortainerError } from './types'

const dispatchers = new Map<string, Agent>()

function dispatcherFor(socketPath: string): Agent {
  let d = dispatchers.get(socketPath)
  if (!d) {
    d = new Agent({ allowH2: false, connect: { socketPath } })
    dispatchers.set(socketPath, d)
  }
  return d
}

function sshOf(conn: PortainerConnection) {
  if (!conn.ssh) throw new PortainerError('Connexion SSH incomplète', 'unsupported')
  return conn.ssh
}

export const sshTransport: DockerTransport = {
  label: 'Docker (SSH)',
  authError: 'Accès refusé par Docker sur l\'hôte : l\'utilisateur SSH doit pouvoir utiliser le socket Docker',
  target: async conn => ({ base: 'http://docker', dispatcher: dispatcherFor(await sshDockerSocket(sshOf(conn))) }),
  dockerPrefix: () => '',
  interactive: true,
  headers: () => ({}),
}

/** Version du moteur Docker : seule version pertinente sans agent. */
export const sshVersionLabel = (dockerVersion: string) => `Docker ${dockerVersion} (SSH)`

export function createSshAdapter(opts: HttpAdapterOptions): PortainerAdapter {
  const base = createDockerOps(opts, sshTransport)
  const LONG_MS = Math.max(opts.timeoutMs, 10 * 60_000)

  async function info(conn: PortainerConnection) {
    const { base: url, dispatcher } = await sshTransport.target(conn)
    const res = await fetch(`${url}/info`, { dispatcher, signal: AbortSignal.timeout(opts.timeoutMs) }).catch((err) => { throw err instanceof PortainerError ? err : new PortainerError(`Docker injoignable par SSH : ${(err as Error).message}`, 'network') })
    if (res.status === 401 || res.status === 403) throw new PortainerError(sshTransport.authError, 'auth', res.status)
    if (!res.ok) throw new PortainerError(`Docker a répondu ${res.status} sur /info`, 'http', res.status)
    return await res.json() as { Name?: string, ServerVersion?: string, Swarm?: { LocalNodeState?: string } }
  }

  return {
    ...base,
    ...composeStackOps(base, LONG_MS),

    async getVersion(conn) {
      const i = await info(conn)
      if (!i.ServerVersion) throw new PortainerError('Pas de moteur Docker derrière ce socket', 'unsupported')
      const major = Number.parseInt(i.ServerVersion, 10)
      return { version: sshVersionLabel(i.ServerVersion), supported: major >= 20 }
    },

    async listEndpoints(conn) {
      const i = await info(conn)
      const swarm = i.Swarm?.LocalNodeState === 'active'
      return [{ id: HOST_ENDPOINT_ID, name: i.Name || sshOf(conn).host, kind: swarm ? 'docker_swarm' : 'docker_standalone', url: conn.url, online: true, rawType: 2 }]
    },
  }
}
