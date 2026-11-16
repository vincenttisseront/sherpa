/**
 * Adaptateur des hôtes en mémoire pour le développement et les tests.
 * Comportements pilotables par le token :
 * - contient "invalid"  → erreur d'authentification ;
 * - contient "timeout"  → erreur de délai ;
 * - contient "v1"       → version non supportée.
 */
import { Duplex, Readable } from 'node:stream'
import type { DockerNetwork, DockerVolume, PortainerAdapter, PortainerConnection, PortainerEndpoint, PortainerStack } from './types'
import { PortainerError, isSupportedVersion } from './types'

const ENDPOINTS: PortainerEndpoint[] = [
  { id: 1, name: 'local', kind: 'docker_standalone', url: 'unix:///var/run/docker.sock', online: true, rawType: 1 },
  { id: 2, name: 'docker-prod-01', kind: 'docker_standalone', url: 'tcp://10.0.0.11:9001', online: true, rawType: 2 },
  { id: 3, name: 'swarm-lab', kind: 'docker_swarm', url: 'tcp://10.0.0.21:9001', online: false, rawType: 2 },
]

const NETWORKS: DockerNetwork[] = [
  { id: 'n-bridge', name: 'bridge', driver: 'bridge', scope: 'local', internal: false, attachable: false, labels: {} },
  { id: 'n-host', name: 'host', driver: 'host', scope: 'local', internal: false, attachable: false, labels: {} },
  { id: 'n-traefik', name: 'traefik-public', driver: 'bridge', scope: 'local', internal: false, attachable: true, labels: { role: 'traefik' } },
  { id: 'n-backend', name: 'apps-backend', driver: 'bridge', scope: 'local', internal: true, attachable: true, labels: {} },
]

function guard(conn: PortainerConnection): void {
  if (conn.token.includes('invalid')) throw new PortainerError('Token refusé par Portainer', 'auth', 401)
  if (conn.token.includes('timeout')) throw new PortainerError('Délai dépassé', 'timeout')
}

/** Services d'un Compose, pour simuler ses conteneurs. Un service nommé « broken » ne démarre jamais. */
function servicesOf(compose: string): string[] {
  const m = /^services:\s*\n((?:[ \t]+.*\n?)*)/m.exec(compose)
  if (!m) return []
  return [...m[1]!.matchAll(/^ {2}([A-Za-z0-9_.-]+):/gm)].map(x => x[1]!)
}

export function createMockPortainerAdapter(): PortainerAdapter {
  const stacks = new Map<number, PortainerStack>()
  const stackServices = new Map<number, string[]>()
  let nextStackId = 1

  const endpointOrThrow = (id: number) => {
    const e = ENDPOINTS.find(x => x.id === id)
    if (!e) throw new PortainerError(`Endpoint ${id} introuvable`, 'not_found', 404)
    return e
  }

  return {
    async getVersion(conn) {
      guard(conn)
      const version = conn.token.includes('v1') ? '1.24.2' : '2.27.4'
      return { version, supported: isSupportedVersion(version) }
    },
    async listEndpoints(conn) {
      guard(conn)
      return structuredClone(ENDPOINTS)
    },
    async listNetworks(conn, endpointId) {
      guard(conn)
      endpointOrThrow(endpointId)
      return structuredClone(NETWORKS)
    },
    async listVolumes(conn, endpointId): Promise<DockerVolume[]> {
      guard(conn)
      endpointOrThrow(endpointId)
      return [
        { name: 'portainer_data', driver: 'local', mountpoint: '/var/lib/docker/volumes/portainer_data/_data', labels: {} },
        { name: 'demo_pgdata', driver: 'local', mountpoint: '/var/lib/docker/volumes/demo_pgdata/_data', labels: { 'com.docker.compose.project': 'demo' } },
      ]
    },
    async listContainers(conn, endpointId) {
      guard(conn)
      endpointOrThrow(endpointId)
      return [
        { id: 'c-traefik', names: ['traefik'], image: 'traefik:v3.5', state: 'running', status: 'Up 3 days', labels: {}, networks: ['traefik-public'], createdAt: '2026-10-01T08:00:00.000Z' },
        { id: 'c-portainer-agent', names: ['portainer_agent'], image: 'portainer/agent:2.27.4', state: 'running', status: 'Up 3 days', labels: {}, networks: ['bridge'], createdAt: '2026-10-01T08:00:00.000Z' },
      ]
    },
    async listImages(conn, endpointId) {
      guard(conn)
      endpointOrThrow(endpointId)
      return [{ id: 'sha256:aaa', tags: ['traefik:v3.5'], sizeBytes: 180_000_000, createdAt: '2026-09-15T00:00:00.000Z' }]
    },
    async listStacks(conn) {
      guard(conn)
      return [...stacks.values()]
    },
    async createStack(conn, input) {
      guard(conn)
      endpointOrThrow(input.endpointId)
      if ([...stacks.values()].some(s => s.name === input.name && s.endpointId === input.endpointId)) {
        throw new PortainerError(`Une stack ${input.name} existe déjà`, 'http', 409)
      }
      const stack: PortainerStack = { id: nextStackId++, name: input.name, endpointId: input.endpointId, status: 'active', type: 'compose' }
      stacks.set(stack.id, stack)
      stackServices.set(stack.id, servicesOf(input.composeContent))
      return stack
    },
    async updateStack(conn, stackId, input) {
      guard(conn)
      const s = stacks.get(stackId)
      if (!s) throw new PortainerError(`Stack ${stackId} introuvable`, 'not_found', 404)
      stackServices.set(stackId, servicesOf(input.composeContent))
      s.status = 'active'
      return s
    },
    async stopStack(conn, stackId) {
      guard(conn)
      const s = stacks.get(stackId)
      if (s) s.status = 'inactive'
    },
    async startStack(conn, stackId) {
      guard(conn)
      const s = stacks.get(stackId)
      if (s) s.status = 'active'
    },
    async deleteStack(conn, stackId) {
      guard(conn)
      stacks.delete(stackId)
      stackServices.delete(stackId)
    },
    async findStack(conn, name, endpointId) {
      guard(conn)
      return [...stacks.values()].find(s => s.name === name && s.endpointId === endpointId) ?? null
    },
    async stackContainers(conn, endpointId, stackName) {
      guard(conn)
      const s = [...stacks.values()].find(x => x.name === stackName && x.endpointId === endpointId)
      if (!s) return []
      return (stackServices.get(s.id) ?? []).map((svc, i) => {
        const broken = svc === 'broken'
        const running = s.status === 'active' && !broken
        return { id: `mock-${s.id}-${i}`, name: `${stackName}-${svc}-1`, service: svc, status: running ? 'running' : 'exited', running, health: running ? 'healthy' as const : null, exitCode: running ? null : 1, restartCount: broken ? 3 : 0, startedAt: new Date().toISOString(), image: 'mock', imageId: `sha256:mock-${svc}`, labels: {} }
      })
    },
    async containerLogs(conn) {
      guard(conn)
      return ['[mock] démarrage', '[mock] erreur : configuration manquante']
    },
    async restartContainer(conn) {
      guard(conn)
    },
    async stopContainer(conn) {
      guard(conn)
    },
    async startContainer(conn) {
      guard(conn)
    },
    async engineInfo(conn) {
      guard(conn)
      return { containers: 2, running: 2, paused: 0, stopped: 0, images: 4, serverVersion: '29.0.0', os: 'Mock OS', kernel: '6.0', cpus: 4, memoryBytes: 8 * 1024 ** 3, name: 'mock' }
    },
    async inspectContainer(conn, _endpointId, containerId) {
      guard(conn)
      return { id: containerId, name: containerId, image: 'mock:1', imageId: 'sha256:mock', createdAt: '2026-10-01T08:00:00.000Z', state: { status: 'running', running: true, restarting: false, oomKilled: false, exitCode: null, startedAt: '2026-10-01T08:00:00.000Z', finishedAt: null, error: null }, restartCount: 0, restartPolicy: 'unless-stopped', health: null, command: [], entrypoint: [], workingDir: null, user: null, envKeys: ['PATH'], labels: {}, mounts: [], networks: [{ name: 'bridge', ip: '172.17.0.2', aliases: [] }], ports: [] }
    },
    async containerStats(conn) {
      guard(conn)
      return { cpuPercent: 1.5, memoryBytes: 64 * 1024 ** 2, memoryLimitBytes: 8 * 1024 ** 3, netRxBytes: 1000, netTxBytes: 500, blockReadBytes: 0, blockWriteBytes: 0, pids: 3, at: new Date().toISOString() }
    },
    async diskUsage(conn) {
      guard(conn)
      return { usage: { images: { count: 4, active: 2, sizeBytes: 900e6, reclaimableBytes: 300e6 }, containers: { count: 2, running: 2, sizeBytes: 1e6, reclaimableBytes: 0 }, volumes: { count: 1, active: 1, sizeBytes: 10e6, reclaimableBytes: 0 }, buildCache: { count: 0, sizeBytes: 0, reclaimableBytes: 0 } }, volumes: [], images: [] }
    },
    async listNetworksDetailed(conn) {
      guard(conn)
      return [{ id: 'n1', name: 'bridge', driver: 'bridge', scope: 'local', internal: false, labels: {}, createdAt: null, subnets: ['172.17.0.0/16'] }]
    },
    async pruneContainers(conn) {
      guard(conn)
      return { deleted: [], reclaimedBytes: 0 }
    },
    async pruneImages(conn) {
      guard(conn)
      return { deleted: [], reclaimedBytes: 0 }
    },
    async pruneBuildCache(conn) {
      guard(conn)
      return { deleted: [], reclaimedBytes: 0 }
    },
    async removeVolume(conn) {
      guard(conn)
    },
    async removeImage(conn) {
      guard(conn)
    },
    async removeNetwork(conn) {
      guard(conn)
    },
    async createNetwork(conn, _endpointId, name) {
      guard(conn)
      if (!NETWORKS.some(n => n.name === name)) NETWORKS.push({ id: `n-${name}`, name, driver: 'bridge', scope: 'local', internal: false, attachable: true, labels: { 'platform.managed': 'true' } })
    },
    async readContainerFiles(conn) {
      guard(conn)
      return null
    },
    async inspectNetwork(conn) {
      guard(conn)
      return null
    },
    async createNetworkSpec(conn, _endpointId, spec) {
      guard(conn)
      return `n-${spec.name}`
    },
    async connectNetwork(conn) {
      guard(conn)
    },
    async disconnectNetwork(conn) {
      guard(conn)
    },
    async removeContainer(conn) {
      guard(conn)
    },
    async runOneShot(conn, _endpointId, spec) {
      guard(conn)
      return { exitCode: 0, logs: [`[mock] ${spec.image} ${spec.cmd.join(' ')}`], outputs: Object.fromEntries(spec.outputs.map(p => [p, null])) }
    },
    async detachContainer(conn, _endpointId, containerId) {
      guard(conn)
      return { id: `${containerId}-detached`, name: containerId }
    },
    async signalContainer(conn) {
      guard(conn)
    },
    async openExec(conn, _endpointId, containerId, o) {
      guard(conn)
      // Terminal factice : une invite, puis la saisie est renvoyée telle quelle ; « exit » ferme la session.
      const stream = new Duplex({
        read() {},
        write(chunk: Buffer, _enc, cb) {
          if (/(^|\r|\n)exit\s*[\r\n]/.test(chunk.toString())) setImmediate(() => stream.push(null))
          else stream.push(chunk)
          cb()
        },
      })
      setImmediate(() => stream.push(`mock:${containerId.slice(0, 8)} ${o.cmd.join(' ')} ${o.cols}x${o.rows}\r\n$ `))
      return { stream, resize: async () => undefined, close: () => stream.destroy() }
    },
    async createVolume(conn) {
      guard(conn)
    },
    async createHolder(conn) {
      guard(conn)
      return 'mock-holder'
    },
    async pullImage(conn, _endpointId, image) {
      guard(conn)
      return { id: `sha256:${Buffer.from(image).toString('hex').padEnd(64, '0').slice(0, 64)}` }
    },
    async openArchive(conn) {
      guard(conn)
      // Archive tar vide : deux blocs de zéros.
      return { stream: Readable.from([Buffer.alloc(1024)]), isDir: true }
    },
    async putArchive(conn, _endpointId, _containerId, _path, body) {
      guard(conn)
      for await (const _ of body) { /* consommé */ }
    },
    async inspectConfig(conn, _endpointId, containerId) {
      guard(conn)
      const traefik = containerId === 'c-traefik'
      return {
        id: containerId, name: traefik ? 'traefik' : containerId, image: traefik ? 'traefik:v3.5' : 'mock:1', imageId: 'sha256:mock', state: 'running',
        entrypoint: traefik ? ['/entrypoint.sh'] : null,
        cmd: traefik ? ['--providers.docker=true', '--providers.docker.exposedbydefault=false', '--providers.docker.network=traefik-public', '--entrypoints.web.address=:80', '--entrypoints.websecure.address=:443', '--entrypoints.web.http.redirections.entrypoint.to=websecure', '--certificatesresolvers.le.acme.httpchallenge.entrypoint=web'] : [],
        workingDir: null, user: null, env: ['PATH=/usr/bin'], labels: {}, healthcheck: null, restartPolicy: 'unless-stopped', privileged: false, capAdd: [], capDrop: [], networkMode: null,
        portBindings: traefik ? [{ container: '80/tcp', hostIp: null, hostPort: '80' }, { container: '443/tcp', hostIp: null, hostPort: '443' }] : [],
        exposedPorts: [], mounts: [], networks: [{ name: traefik ? 'traefik-public' : 'bridge', aliases: [] }], extraHosts: [], stopSignal: null, tty: false,
      }
    },
    async imageConfig(conn) {
      guard(conn)
      return { env: ['PATH=/usr/bin'], cmd: null, entrypoint: null, workingDir: null, user: null, labels: {}, healthcheck: null }
    },
    async imageInfo(conn, _endpointId, imageId) {
      guard(conn)
      return { id: imageId, repoDigests: [], created: null }
    },
  }
}
