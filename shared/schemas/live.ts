/** Vue en direct des conteneurs des endpoints gérés (lecture seule). */

export type LiveState = 'running' | 'restarting' | 'paused' | 'created' | 'exited' | 'dead' | 'removing'
export type LiveHealth = 'healthy' | 'unhealthy' | 'starting' | null

export interface LiveContainer {
  id: string
  name: string
  image: string
  state: LiveState
  /** Libellé Docker (« Up 3 hours (healthy) »). */
  status: string
  health: LiveHealth
  createdAt: string
  command: string | null
  ports: { ip: string | null, privatePort: number, publicPort: number | null, type: string }[]
  mounts: { type: string, source: string | null, destination: string, rw: boolean, name: string | null }[]
  networks: string[]
  /** Domaines déclarés par les labels du conteneur (Traefik, caddy-docker-proxy). */
  hosts: string[]
  /** Projet Compose (stack) et service. */
  stack: string | null
  service: string | null
  /** Déployé par la plateforme (label platform.managed). */
  managed: boolean
  /** Projet et cible de la plateforme qui gèrent la stack. */
  project: { id: string, name: string, environment: string, targetId?: string } | null
}

export interface LiveEngine {
  containers: number
  running: number
  paused: number
  stopped: number
  images: number
  serverVersion: string | null
  os: string | null
  cpus: number | null
  memoryBytes: number | null
  name: string | null
}

export interface LiveEndpoint {
  endpointId: string
  endpointName: string
  serverId: string
  serverName: string
  scannedAt: string
  durationMs: number
  ok: boolean
  error: string | null
  engine: LiveEngine | null
  containers: LiveContainer[]
}

export interface LiveContainerDetail {
  container: import('../../server/adapters/portainer/types').ContainerDetail
  stats: import('../../server/adapters/portainer/types').ContainerStats | null
  project: LiveContainer['project']
  /** L'hôte laisse ouvrir un terminal (SSH) ; faux pour un hôte joint par l'agent Portainer. */
  execSupported: boolean
}
