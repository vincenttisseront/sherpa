/**
 * Opérations Docker de l'adaptateur, communes à tout transport : agent
 * Portainer (requêtes signées) ou SSH (relais local vers le socket de l'hôte).
 *
 * - Timeout par requête, retries limités et uniquement sur les GET.
 * - Vérification TLS configurable par serveur, avec CA privée optionnelle.
 * - Les messages d'erreur ne contiennent jamais de secret.
 */
import { posix } from 'node:path'
import { Readable } from 'node:stream'
import { extract, pack } from 'tar-stream'
import { Agent, type Dispatcher, fetch } from 'undici'
import { redactPatterns } from '../../utils/redact'
import type {
  ContainerConfig,
  DockerContainer,
  DockerImage,
  DockerNetwork,
  DockerVolume,
  OneShotResult,
  PortainerAdapter,
  PortainerConnection,
} from './types'
import { PortainerError } from './types'

export interface HttpAdapterOptions {
  timeoutMs: number
  maxRetries: number
}

/** Accès à l'API Docker d'un endpoint : destination, préfixe des chemins et en-têtes d'authentification. */
export interface DockerTransport {
  label: string
  authError: string
  /** Adresse de base et dispatcher HTTP (agent : HTTPS ; SSH : relais local vers le socket de l'hôte). */
  target(conn: PortainerConnection): Promise<{ base: string, dispatcher: Dispatcher }>
  dockerPrefix(endpointId: number): string
  /** Le transport laisse passer les connexions détachées (docker exec interactif) : SSH oui, proxy de l'agent Portainer non. */
  interactive?: boolean
  headers(conn: PortainerConnection): Record<string, string>
}

type Method = 'GET' | 'POST' | 'PUT' | 'DELETE'

const agents = new Map<string, Agent>()

export function agentFor(conn: PortainerConnection): Agent {
  const key = `${conn.tlsVerify}|${conn.caCertPem ?? ''}`
  let agent = agents.get(key)
  if (!agent) {
    agent = new Agent({
      // HTTP/1.1 : undici négocie HTTP/2 par défaut ; l'API Docker relayée par l'agent reçoit alors
      // les POST sans corps avec une longueur inconnue, et Docker refuse /containers/{id}/start.
      allowH2: false,
      connect: {
        rejectUnauthorized: conn.tlsVerify,
        ...(conn.caCertPem ? { ca: conn.caCertPem } : {}),
      },
    })
    agents.set(key, agent)
  }
  return agent
}

export function classify(err: unknown): PortainerError {
  if (err instanceof PortainerError) return err
  const e = err as { name?: string, code?: string, cause?: { code?: string, message?: string }, message?: string }
  const code = e.cause?.code ?? e.code ?? ''
  if (e.name === 'TimeoutError' || e.name === 'AbortError') return new PortainerError('Délai dépassé', 'timeout')
  if (/CERT|SELF_SIGNED|UNABLE_TO_VERIFY|ERR_TLS/i.test(code)) return new PortainerError(`Erreur TLS : ${code}`, 'tls')
  return new PortainerError(`Erreur réseau : ${redactPatterns(code || e.cause?.message || e.message || 'inconnue')}`, 'network')
}

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))

/**
 * Logs Docker sans TTY : trames [flux(1), 0, 0, 0, taille(4, big-endian)] + données.
 * Avec TTY, le flux est brut : on le renvoie tel quel.
 */
export function demuxDockerLogs(buf: Buffer): string[] {
  const out: string[] = []
  let i = 0
  const framed = buf.length >= 8 && [0, 1, 2].includes(buf[0]!) && buf[1] === 0 && buf[2] === 0 && buf[3] === 0
  if (!framed) return buf.toString('utf8').split('\n').filter(Boolean)
  while (i + 8 <= buf.length) {
    const size = buf.readUInt32BE(i + 4)
    out.push(buf.subarray(i + 8, i + 8 + size).toString('utf8'))
    i += 8 + size
  }
  return out.join('').split('\n').filter(Boolean)
}

/** Opérations propres au protocole de connexion (version, endpoints, stacks) : fournies par l'adaptateur agent. */
export type ConnectionOps = 'getVersion' | 'listEndpoints' | 'listStacks' | 'createStack' | 'updateStack' | 'stopStack' | 'startStack' | 'deleteStack' | 'findStack'
export type DockerOps = Omit<PortainerAdapter, ConnectionOps>

export function createDockerOps(opts: HttpAdapterOptions, t: DockerTransport): DockerOps {
  /** Opérations longues (compose up/down, pull d'images, arrêt gracieux) : délai dédié. */
  const LONG_MS = Math.max(opts.timeoutMs, 10 * 60_000)

  async function call<T>(conn: PortainerConnection, method: Method, path: string, body?: unknown, okEmpty = false, timeoutMs = opts.timeoutMs): Promise<T> {
    const attempts = method === 'GET' ? opts.maxRetries + 1 : 1
    let lastError: PortainerError | undefined
    for (let attempt = 1; attempt <= attempts; attempt++) {
      try {
        const { base, dispatcher } = await t.target(conn)
        const res = await fetch(`${base}${path}`, {
          method,
          dispatcher,
          signal: AbortSignal.timeout(timeoutMs),
          headers: {
            ...t.headers(conn),
            'Accept': 'application/json',
            ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
          },
          body: body !== undefined ? JSON.stringify(body) : undefined,
        })
        if (res.status === 401 || res.status === 403) throw new PortainerError(t.authError, 'auth', res.status)
        if (res.status === 404) throw new PortainerError(`Ressource introuvable : ${path}`, 'not_found', 404)
        if (!res.ok) {
          const text = redactPatterns((await res.text()).slice(0, 500))
          throw new PortainerError(`${t.label} a répondu ${res.status} sur ${method} ${path} : ${text}`, 'http', res.status)
        }
        if (okEmpty || res.status === 204) return undefined as T
        return await res.json() as T
      }
      catch (err) {
        lastError = classify(err)
        const retryable = lastError.kind === 'network' || lastError.kind === 'timeout' || (lastError.status ?? 0) >= 500
        if (!retryable || attempt === attempts) break
        await sleep(250 * 2 ** (attempt - 1))
      }
    }
    throw lastError!
  }

  const docker = <T>(conn: PortainerConnection, endpointId: number, path: string) =>
    call<T>(conn, 'GET', `${t.dockerPrefix(endpointId)}${path}`)

  /** Image absente : tirée (le flux de progression est lu jusqu'au bout, erreurs comprises). */
  async function ensureImage(conn: PortainerConnection, endpointId: number, image: string, force = false) {
    const prefix = t.dockerPrefix(endpointId)
    const present = force ? false : await call(conn, 'GET', `${prefix}/images/${encodeURIComponent(image)}/json`).then(() => true, (err: PortainerError) => {
      if (err.kind === 'not_found') return false
      throw err
    })
    if (present) return
    const target = await t.target(conn).catch((err) => { throw classify(err) })
    // « nom:tag », « registre:port/nom:tag » ou « nom@sha256:… » (empreinte : pas de tag séparé).
    const at = image.lastIndexOf(':')
    const tagged = !image.includes('@') && at > image.lastIndexOf('/')
    const query = image.includes('@') ? `fromImage=${encodeURIComponent(image)}` : tagged ? `fromImage=${encodeURIComponent(image.slice(0, at))}&tag=${encodeURIComponent(image.slice(at + 1))}` : `fromImage=${encodeURIComponent(image)}&tag=latest`
    const res = await fetch(`${target.base}${prefix}/images/create?${query}`, {
      method: 'POST',
      dispatcher: target.dispatcher,
      signal: AbortSignal.timeout(LONG_MS),
      headers: t.headers(conn),
    }).catch((err) => { throw classify(err) })
    const text = await res.text()
    const failed = text.split('\n').map(l => { try { return JSON.parse(l) as { error?: string } } catch { return {} } }).find(l => l.error)
    if (!res.ok || failed) throw new PortainerError(`Image ${image} indisponible : ${redactPatterns(failed?.error ?? String(res.status)).slice(0, 200)}`, 'http', res.status)
  }

  return {
    async listNetworks(conn, endpointId): Promise<DockerNetwork[]> {
      const raw = await docker<{ Id: string, Name: string, Driver: string, Scope: string, Internal: boolean, Attachable: boolean, Labels: Record<string, string> | null }[]>(conn, endpointId, '/networks')
      return raw.map(n => ({ id: n.Id, name: n.Name, driver: n.Driver, scope: n.Scope, internal: n.Internal, attachable: n.Attachable, labels: n.Labels ?? {} }))
    },

    async listVolumes(conn, endpointId): Promise<DockerVolume[]> {
      const raw = await docker<{ Volumes: { Name: string, Driver: string, Mountpoint?: string, Labels: Record<string, string> | null }[] | null }>(conn, endpointId, '/volumes')
      return (raw.Volumes ?? []).map(v => ({ name: v.Name, driver: v.Driver, mountpoint: v.Mountpoint ?? null, labels: v.Labels ?? {} }))
    },

    async listContainers(conn, endpointId): Promise<DockerContainer[]> {
      const raw = await docker<{
        Id: string, Names: string[], Image: string, ImageID?: string, Command?: string, State: string, Status: string, Labels: Record<string, string> | null, Created: number
        NetworkSettings?: { Networks?: Record<string, unknown> }
        Ports?: { IP?: string, PrivatePort: number, PublicPort?: number, Type: string }[]
        Mounts?: { Type: string, Source?: string, Destination: string, RW: boolean, Name?: string }[]
      }[]>(conn, endpointId, '/containers/json?all=1')
      return raw.map(c => ({
        id: c.Id,
        names: c.Names.map(n => n.replace(/^\//, '')),
        image: c.Image,
        imageId: c.ImageID,
        command: c.Command === undefined ? undefined : redactPatterns(c.Command),
        state: c.State,
        status: c.Status,
        labels: c.Labels ?? {},
        networks: Object.keys(c.NetworkSettings?.Networks ?? {}),
        createdAt: new Date(c.Created * 1000).toISOString(),
        // IPv4 et IPv6 annoncent le même port : dédoublonnés.
        ports: [...new Map((c.Ports ?? []).map(p => [`${p.PrivatePort}/${p.Type}:${p.PublicPort ?? ''}`, { ip: p.IP ?? null, privatePort: p.PrivatePort, publicPort: p.PublicPort ?? null, type: p.Type }])).values()],
        mounts: (c.Mounts ?? []).map(m => ({ type: m.Type, source: m.Source ?? null, destination: m.Destination, rw: m.RW, name: m.Name ?? null })),
      }))
    },

    async listImages(conn, endpointId): Promise<DockerImage[]> {
      const raw = await docker<{ Id: string, RepoTags: string[] | null, Size: number, Created: number }[]>(conn, endpointId, '/images/json')
      return raw.map(i => ({ id: i.Id, tags: i.RepoTags ?? [], sizeBytes: i.Size, createdAt: new Date(i.Created * 1000).toISOString() }))
    },

    async stackContainers(conn, endpointId, stackName) {
      const filters = encodeURIComponent(JSON.stringify({ label: [`com.docker.compose.project=${stackName}`] }))
      const list = await docker<{ Id: string }[]>(conn, endpointId, `/containers/json?all=1&filters=${filters}`)
      return Promise.all(list.map(async (c) => {
        const i = await docker<{
          Id: string, Name: string, Image: string, RestartCount: number, Config: { Image: string, Labels: Record<string, string> | null }
          State: { Status: string, Running: boolean, ExitCode: number, StartedAt: string, Health?: { Status: string } }
        }>(conn, endpointId, `/containers/${c.Id}/json`)
        const h = i.State.Health?.Status
        return {
          id: i.Id,
          name: i.Name.replace(/^\//, ''),
          service: i.Config.Labels?.['com.docker.compose.service'] ?? null,
          status: i.State.Status,
          running: i.State.Running,
          health: h === 'healthy' || h === 'unhealthy' || h === 'starting' ? h : null,
          exitCode: i.State.Running ? null : i.State.ExitCode,
          restartCount: i.RestartCount,
          startedAt: i.State.StartedAt ?? null,
          image: i.Config.Image,
          imageId: i.Image,
          labels: i.Config.Labels ?? {},
        }
      }))
    },

    async containerLogs(conn, endpointId, containerId, tail) {
      const { base, dispatcher } = await t.target(conn).catch((err) => { throw classify(err) })
      const res = await fetch(`${base}${t.dockerPrefix(endpointId)}/containers/${containerId}/logs?stdout=1&stderr=1&timestamps=0&tail=${tail}`, {
        dispatcher,
        signal: AbortSignal.timeout(opts.timeoutMs),
        headers: t.headers(conn),
      }).catch((err) => { throw classify(err) })
      if (!res.ok) throw new PortainerError(`Logs indisponibles (${res.status})`, 'http', res.status)
      return demuxDockerLogs(Buffer.from(await res.arrayBuffer()))
    },

    async restartContainer(conn, endpointId, containerId) {
      // Arrêt gracieux de 10 s maximum, puis redémarrage.
      await call(conn, 'POST', `${t.dockerPrefix(endpointId)}/containers/${containerId}/restart?t=10`, undefined, true, 60_000)
    },

    async stopContainer(conn, endpointId, containerId) {
      await call(conn, 'POST', `${t.dockerPrefix(endpointId)}/containers/${containerId}/stop?t=10`, undefined, true, 60_000)
        .catch((err: PortainerError) => { if (err.status !== 304) throw err })
    },

    async startContainer(conn, endpointId, containerId) {
      // 304 : déjà dans l'état demandé.
      await call(conn, 'POST', `${t.dockerPrefix(endpointId)}/containers/${containerId}/start`, undefined, true, 60_000)
        .catch((err: PortainerError) => { if (err.status !== 304) throw err })
    },

    async connectNetwork(conn, endpointId, network, containerId, aliases) {
      await call(conn, 'POST', `${t.dockerPrefix(endpointId)}/networks/${encodeURIComponent(network)}/connect`, { Container: containerId, ...(aliases?.length ? { EndpointConfig: { Aliases: aliases } } : {}) }, true, 60_000)
        .catch((err: PortainerError) => { if (!(err.status === 403 && /already exists|already attached/i.test(err.message))) throw err })
    },

    async disconnectNetwork(conn, endpointId, network, containerId) {
      await call(conn, 'POST', `${t.dockerPrefix(endpointId)}/networks/${encodeURIComponent(network)}/disconnect`, { Container: containerId, Force: false }, true, 60_000)
        .catch((err: PortainerError) => { if (!(err.status === 404 || /is not connected/i.test(err.message))) throw err })
    },

    async removeContainer(conn, endpointId, containerId) {
      await call(conn, 'DELETE', `${t.dockerPrefix(endpointId)}/containers/${encodeURIComponent(containerId)}?force=true&v=false`, undefined, true, 60_000)
    },

    async engineInfo(conn, endpointId) {
      const i = await docker<{ Containers: number, ContainersRunning: number, ContainersPaused: number, ContainersStopped: number, Images: number, ServerVersion?: string, OperatingSystem?: string, KernelVersion?: string, NCPU?: number, MemTotal?: number, Name?: string }>(conn, endpointId, '/info')
      return { containers: i.Containers, running: i.ContainersRunning, paused: i.ContainersPaused, stopped: i.ContainersStopped, images: i.Images, serverVersion: i.ServerVersion ?? null, os: i.OperatingSystem ?? null, kernel: i.KernelVersion ?? null, cpus: i.NCPU ?? null, memoryBytes: i.MemTotal ?? null, name: i.Name ?? null }
    },

    async inspectContainer(conn, endpointId, containerId) {
      let i: {
        Id: string, Name: string, Image: string, Created: string, RestartCount: number
        State: { Status: string, Running: boolean, Restarting: boolean, OOMKilled: boolean, ExitCode: number, StartedAt: string, FinishedAt: string, Error: string, Health?: { Status: string, FailingStreak: number, Log?: { Start: string, ExitCode: number, Output: string }[] } }
        Config: { Image: string, Cmd: string[] | null, Entrypoint: string[] | null, WorkingDir: string, User: string, Env: string[] | null, Labels: Record<string, string> | null }
        HostConfig: { RestartPolicy?: { Name: string } }
        Mounts: { Type: string, Source?: string, Destination: string, RW: boolean, Name?: string }[]
        NetworkSettings: { Networks: Record<string, { IPAddress?: string, Aliases?: string[] | null }>, Ports: Record<string, { HostIp: string, HostPort: string }[] | null> | null }
      }
      try {
        i = await docker(conn, endpointId, `/containers/${encodeURIComponent(containerId)}/json`)
      }
      catch (err) {
        if ((err as PortainerError).kind === 'not_found') return null
        throw err
      }
      const h = i.State.Health
      return {
        id: i.Id,
        name: i.Name.replace(/^\//, ''),
        image: i.Config.Image,
        imageId: i.Image,
        createdAt: i.Created,
        state: { status: i.State.Status, running: i.State.Running, restarting: i.State.Restarting, oomKilled: i.State.OOMKilled, exitCode: i.State.Running ? null : i.State.ExitCode, startedAt: i.State.StartedAt?.startsWith('0001') ? null : i.State.StartedAt, finishedAt: i.State.FinishedAt?.startsWith('0001') ? null : i.State.FinishedAt, error: i.State.Error || null },
        restartCount: i.RestartCount,
        restartPolicy: i.HostConfig.RestartPolicy?.Name || null,
        health: h ? { status: h.Status, failingStreak: h.FailingStreak, log: (h.Log ?? []).slice(-5).map(l => ({ start: l.Start, exitCode: l.ExitCode, output: redactPatterns(l.Output.slice(0, 2000)) })) } : null,
        // Une ligne de commande peut contenir un secret en clair : masquée comme les logs.
        command: (i.Config.Cmd ?? []).map(redactPatterns),
        entrypoint: (i.Config.Entrypoint ?? []).map(redactPatterns),
        workingDir: i.Config.WorkingDir || null,
        user: i.Config.User || null,
        // Jamais les valeurs : elles contiennent souvent des secrets.
        envKeys: (i.Config.Env ?? []).map(e => e.split('=')[0]!).sort(),
        labels: i.Config.Labels ?? {},
        mounts: i.Mounts.map(m => ({ type: m.Type, source: m.Source ?? null, destination: m.Destination, rw: m.RW, name: m.Name ?? null })),
        networks: Object.entries(i.NetworkSettings.Networks ?? {}).map(([name, n]) => ({ name, ip: n.IPAddress || null, aliases: n.Aliases ?? [] })),
        ports: Object.entries(i.NetworkSettings.Ports ?? {}).flatMap(([container, binds]): { container: string, host: string | null }[] => (binds?.length ? binds.map(b => ({ container, host: `${b.HostIp}:${b.HostPort}` })) : [{ container, host: null }])),
      }
    },

    async containerStats(conn, endpointId, containerId) {
      let s: {
        read: string
        cpu_stats: { cpu_usage: { total_usage: number }, system_cpu_usage?: number, online_cpus?: number }
        precpu_stats: { cpu_usage: { total_usage: number }, system_cpu_usage?: number }
        memory_stats: { usage?: number, limit?: number, stats?: { inactive_file?: number, cache?: number } }
        networks?: Record<string, { rx_bytes: number, tx_bytes: number }>
        blkio_stats?: { io_service_bytes_recursive?: { op: string, value: number }[] | null }
        pids_stats?: { current?: number }
      }
      try {
        s = await docker(conn, endpointId, `/containers/${encodeURIComponent(containerId)}/stats?stream=false&one-shot=false`)
      }
      catch (err) {
        if ((err as PortainerError).kind === 'not_found') return null
        throw err
      }
      const cpuDelta = s.cpu_stats.cpu_usage.total_usage - s.precpu_stats.cpu_usage.total_usage
      const sysDelta = (s.cpu_stats.system_cpu_usage ?? 0) - (s.precpu_stats.system_cpu_usage ?? 0)
      const cpus = s.cpu_stats.online_cpus ?? 1
      // Mémoire « utile » : comme docker stats (cache de fichiers inactif exclu).
      const cache = s.memory_stats.stats?.inactive_file ?? s.memory_stats.stats?.cache ?? 0
      const nets = Object.values(s.networks ?? {})
      const io = s.blkio_stats?.io_service_bytes_recursive ?? []
      return {
        cpuPercent: sysDelta > 0 && cpuDelta >= 0 ? Math.round((cpuDelta / sysDelta) * cpus * 1000) / 10 : null,
        memoryBytes: s.memory_stats.usage !== undefined ? Math.max(0, s.memory_stats.usage - cache) : null,
        memoryLimitBytes: s.memory_stats.limit ?? null,
        netRxBytes: nets.length ? nets.reduce((a, n) => a + n.rx_bytes, 0) : null,
        netTxBytes: nets.length ? nets.reduce((a, n) => a + n.tx_bytes, 0) : null,
        blockReadBytes: io.length ? io.filter(x => x.op.toLowerCase() === 'read').reduce((a, x) => a + x.value, 0) : null,
        blockWriteBytes: io.length ? io.filter(x => x.op.toLowerCase() === 'write').reduce((a, x) => a + x.value, 0) : null,
        pids: s.pids_stats?.current ?? null,
        at: s.read,
      }
    },

    async diskUsage(conn, endpointId) {
      const d = await call<{
        LayersSize?: number
        Images?: { Id: string, RepoTags: string[] | null, Size: number, SharedSize: number, Containers: number, Created: number, Labels: Record<string, string> | null }[] | null
        Containers?: { State: string, SizeRw?: number }[] | null
        Volumes?: { Name: string, Driver: string, Labels: Record<string, string> | null, CreatedAt?: string, UsageData?: { Size: number, RefCount: number } | null }[] | null
        BuildCache?: { Size: number, InUse: boolean, Shared: boolean }[] | null
      }>(conn, 'GET', `${t.dockerPrefix(endpointId)}/system/df`, undefined, false, LONG_MS)
      const images = (d.Images ?? []).map(i => ({ id: i.Id, tags: (i.RepoTags ?? []).filter(t => t !== '<none>:<none>'), sizeBytes: i.Size, createdAt: new Date(i.Created * 1000).toISOString(), labels: i.Labels ?? {}, containers: i.Containers, dangling: !(i.RepoTags ?? []).some(t => t !== '<none>:<none>') }))
      const containers = d.Containers ?? []
      const volumes = (d.Volumes ?? []).map(v => ({ name: v.Name, driver: v.Driver, labels: v.Labels ?? {}, sizeBytes: v.UsageData && v.UsageData.Size >= 0 ? v.UsageData.Size : null, refCount: v.UsageData && v.UsageData.RefCount >= 0 ? v.UsageData.RefCount : null, createdAt: v.CreatedAt ?? null }))
      const cache = d.BuildCache ?? []
      const sum = (xs: number[]) => xs.reduce((a, x) => a + Math.max(0, x), 0)
      return {
        usage: {
          images: { count: images.length, active: images.filter(i => i.containers > 0).length, sizeBytes: d.LayersSize ?? sum(images.map(i => i.sizeBytes)), reclaimableBytes: sum((d.Images ?? []).filter(i => i.Containers === 0).map(i => i.Size - Math.max(0, i.SharedSize))) },
          containers: { count: containers.length, running: containers.filter(c => c.State === 'running').length, sizeBytes: sum(containers.map(c => c.SizeRw ?? 0)), reclaimableBytes: sum(containers.filter(c => c.State !== 'running').map(c => c.SizeRw ?? 0)) },
          volumes: { count: volumes.length, active: volumes.filter(v => (v.refCount ?? 0) > 0).length, sizeBytes: sum(volumes.map(v => v.sizeBytes ?? 0)), reclaimableBytes: sum(volumes.filter(v => v.refCount === 0).map(v => v.sizeBytes ?? 0)) },
          buildCache: { count: cache.length, sizeBytes: sum(cache.map(c => c.Size)), reclaimableBytes: sum(cache.filter(c => !c.InUse && !c.Shared).map(c => c.Size)) },
        },
        volumes,
        images,
      }
    },

    async listNetworksDetailed(conn, endpointId) {
      const raw = await docker<{ Id: string, Name: string, Driver: string, Scope: string, Internal: boolean, Labels: Record<string, string> | null, Created?: string, IPAM?: { Config?: { Subnet?: string }[] | null } }[]>(conn, endpointId, '/networks')
      return raw.map(n => ({ id: n.Id, name: n.Name, driver: n.Driver, scope: n.Scope, internal: n.Internal, labels: n.Labels ?? {}, createdAt: n.Created ?? null, subnets: (n.IPAM?.Config ?? []).map(c => c.Subnet).filter((x): x is string => !!x) }))
    },

    async pruneContainers(conn, endpointId, filters) {
      const r = await call<{ ContainersDeleted: string[] | null, SpaceReclaimed: number }>(conn, 'POST', `${t.dockerPrefix(endpointId)}/containers/prune?filters=${encodeURIComponent(JSON.stringify(filters))}`, undefined, false, LONG_MS)
      return { deleted: r.ContainersDeleted ?? [], reclaimedBytes: r.SpaceReclaimed ?? 0 }
    },

    async pruneImages(conn, endpointId, filters) {
      const r = await call<{ ImagesDeleted: { Deleted?: string, Untagged?: string }[] | null, SpaceReclaimed: number }>(conn, 'POST', `${t.dockerPrefix(endpointId)}/images/prune?filters=${encodeURIComponent(JSON.stringify(filters))}`, undefined, false, LONG_MS)
      return { deleted: (r.ImagesDeleted ?? []).map(i => i.Untagged ?? i.Deleted ?? '').filter(Boolean), reclaimedBytes: r.SpaceReclaimed ?? 0 }
    },

    async pruneBuildCache(conn, endpointId, opts) {
      const q = new URLSearchParams({ all: String(opts.all) })
      if (opts.until) q.set('filters', JSON.stringify({ until: [opts.until] }))
      const r = await call<{ CachesDeleted: string[] | null, SpaceReclaimed: number }>(conn, 'POST', `${t.dockerPrefix(endpointId)}/build/prune?${q}`, undefined, false, LONG_MS)
      return { deleted: r.CachesDeleted ?? [], reclaimedBytes: r.SpaceReclaimed ?? 0 }
    },

    async removeVolume(conn, endpointId, name) {
      await call(conn, 'DELETE', `${t.dockerPrefix(endpointId)}/volumes/${encodeURIComponent(name)}`, undefined, true, LONG_MS)
    },

    async removeImage(conn, endpointId, id) {
      // Sans forcer : refusé par Docker si un conteneur l'utilise encore.
      await call(conn, 'DELETE', `${t.dockerPrefix(endpointId)}/images/${encodeURIComponent(id)}?force=false`, undefined, true, LONG_MS)
    },

    async removeNetwork(conn, endpointId, id) {
      await call(conn, 'DELETE', `${t.dockerPrefix(endpointId)}/networks/${encodeURIComponent(id)}`, undefined, true, LONG_MS)
    },

    async createNetwork(conn, endpointId, name) {
      await call(conn, 'POST', `${t.dockerPrefix(endpointId)}/networks/create`, { Name: name, Driver: 'bridge', Attachable: true, CheckDuplicate: true, Labels: { 'platform.managed': 'true' } }, false, 60_000)
    },

    async inspectNetwork(conn, endpointId, idOrName) {
      try {
        const n = await docker<{
          Id: string, Name: string, Driver: string, Scope: string, Internal: boolean, Attachable: boolean, EnableIPv6?: boolean
          Options: Record<string, string> | null, Labels: Record<string, string> | null
          IPAM: { Driver: string, Options: Record<string, string> | null, Config: { Subnet?: string, Gateway?: string, IPRange?: string }[] | null }
          Containers: Record<string, { Name: string, IPv4Address?: string }> | null
        }>(conn, endpointId, `/networks/${encodeURIComponent(idOrName)}`)
        return {
          id: n.Id,
          name: n.Name,
          driver: n.Driver,
          scope: n.Scope,
          internal: n.Internal,
          attachable: n.Attachable,
          enableIPv6: !!n.EnableIPv6,
          options: n.Options ?? {},
          labels: n.Labels ?? {},
          ipam: { driver: n.IPAM.Driver || 'default', options: n.IPAM.Options ?? {}, config: (n.IPAM.Config ?? []).filter(c => c.Subnet).map(c => ({ subnet: c.Subnet!, ...(c.Gateway ? { gateway: c.Gateway } : {}), ...(c.IPRange ? { ipRange: c.IPRange } : {}) })) },
          containers: Object.entries(n.Containers ?? {}).map(([id, c]) => ({ id, name: c.Name, ipv4: c.IPv4Address || null })),
        }
      }
      catch (err) {
        if ((err as PortainerError).kind === 'not_found') return null
        throw err
      }
    },

    async createNetworkSpec(conn, endpointId, spec) {
      const r = await call<{ Id: string }>(conn, 'POST', `${t.dockerPrefix(endpointId)}/networks/create`, {
        Name: spec.name,
        Driver: spec.driver,
        Internal: spec.internal,
        Attachable: spec.attachable,
        EnableIPv6: spec.enableIPv6,
        Options: spec.options,
        Labels: spec.labels,
        CheckDuplicate: true,
        IPAM: { Driver: spec.ipam.driver, Options: spec.ipam.options, Config: spec.ipam.config.map(c => ({ Subnet: c.subnet, ...(c.gateway ? { Gateway: c.gateway } : {}), ...(c.ipRange ? { IPRange: c.ipRange } : {}) })) },
      }, false, 60_000)
      return r.Id
    },

    async readContainerFiles(conn, endpointId, containerId, path, limits) {
      const target = await t.target(conn).catch((err) => { throw classify(err) })
      const res = await fetch(`${target.base}${t.dockerPrefix(endpointId)}/containers/${encodeURIComponent(containerId)}/archive?path=${encodeURIComponent(path)}`, {
        dispatcher: target.dispatcher,
        signal: AbortSignal.timeout(opts.timeoutMs),
        headers: { ...t.headers(conn), 'Accept': 'application/x-tar' },
      }).catch((err) => { throw classify(err) })
      if (res.status === 404) return null
      if (!res.ok || !res.body) throw new PortainerError(`Lecture de fichier impossible (${res.status})`, 'http', res.status)
      // L'archive a pour racine le dernier élément du chemin demandé.
      const base = posix.dirname(path)
      const out: { path: string, content: string }[] = []
      let total = 0
      const ex = extract()
      const done = new Promise<void>((resolve, reject) => {
        ex.on('entry', (header, stream, next) => {
          const chunks: Buffer[] = []
          let size = 0
          const keep = header.type === 'file' && out.length < limits.maxFiles && total + (header.size ?? 0) <= limits.maxBytes
          stream.on('data', (c: unknown) => {
            if (!keep) return
            const b = c as Buffer
            size += b.length
            chunks.push(b)
          })
          stream.on('end', () => {
            if (keep) {
              const buf = Buffer.concat(chunks, size)
              total += size
              // Fichiers binaires ignorés.
              if (!buf.includes(0)) out.push({ path: posix.join(base, header.name), content: buf.toString('utf8') })
            }
            next()
          })
          stream.resume()
        })
        ex.on('finish', resolve)
        ex.on('error', reject)
      })
      const body = Readable.fromWeb(res.body as import('node:stream/web').ReadableStream)
      let read = 0
      // Garde-fou : l'archive ne peut pas dépasser largement le plafond demandé.
      body.on('data', (c: Buffer) => {
        read += c.length
        if (read > limits.maxBytes * 4 + 1024 * 1024) body.destroy(new PortainerError('Configuration trop volumineuse', 'http'))
      })
      body.pipe(ex)
      await Promise.race([done, new Promise((_, reject) => body.on('error', reject))])
      return out
    },

    async detachContainer(conn, endpointId, containerId) {
      const prefix = t.dockerPrefix(endpointId)
      type Raw = {
        Id: string, Name: string, State: { Running: boolean }
        Config: Record<string, unknown> & { Labels?: Record<string, string> | null }
        HostConfig: Record<string, unknown> & { Mounts?: unknown[] | null }
        Mounts: { Type: string, Name?: string, Destination: string, RW: boolean }[]
        NetworkSettings: { Networks: Record<string, { Aliases?: string[] | null, IPAMConfig?: unknown, Links?: string[] | null }> | null }
      }
      const raw = await call<Raw>(conn, 'GET', `${prefix}/containers/${encodeURIComponent(containerId)}/json`)
      const name = raw.Name.replace(/^\//, '')
      const labels = Object.fromEntries(Object.entries(raw.Config.Labels ?? {}).filter(([k]) => !k.startsWith('com.docker.compose.')))
      labels['platform.detached-from'] = raw.Config.Labels?.['com.docker.compose.project'] ?? ''
      // Volumes anonymes : rattachés par leur nom (sinon le nouveau conteneur en recevrait de vides).
      const anonymous = raw.Mounts.filter(m => m.Type === 'volume' && m.Name && /^[0-9a-f]{64}$/.test(m.Name))
      const hostConfig = { ...raw.HostConfig, Mounts: [...(raw.HostConfig.Mounts ?? []), ...anonymous.map(m => ({ Type: 'volume', Source: m.Name, Target: m.Destination, ReadOnly: !m.RW }))] }
      const nets = Object.entries(raw.NetworkSettings.Networks ?? {})
      // Alias : nom du service Compose conservé (les autres conteneurs le joignent par ce nom).
      const service = raw.Config.Labels?.['com.docker.compose.service']
      const endpoint = (n: { Aliases?: string[] | null, IPAMConfig?: unknown }) => ({ Aliases: [...new Set([...(n.Aliases ?? []), ...(service ? [service] : [])])].filter(a => !raw.Id.startsWith(a)), ...(n.IPAMConfig ? { IPAMConfig: n.IPAMConfig } : {}) })
      const [first, ...others] = nets
      const config: Record<string, unknown> = { ...raw.Config, Labels: labels }
      delete config.Hostname
      const old = `${name}-detach-${Date.now().toString(36)}`
      await call(conn, 'POST', `${prefix}/containers/${raw.Id}/stop`, undefined, true, LONG_MS).catch((err: PortainerError) => {
        if (err.status !== 304) throw err
      })
      await call(conn, 'POST', `${prefix}/containers/${raw.Id}/rename?name=${encodeURIComponent(old)}`, undefined, true, 60_000)
      let created: string | null = null
      try {
        created = (await call<{ Id: string }>(conn, 'POST', `${prefix}/containers/create?name=${encodeURIComponent(name)}`, {
          ...config,
          HostConfig: hostConfig,
          ...(first && raw.HostConfig.NetworkMode !== 'host' && !String(raw.HostConfig.NetworkMode ?? '').startsWith('container:') ? { NetworkingConfig: { EndpointsConfig: { [first[0]]: endpoint(first[1]) } } } : {}),
        }, false, 60_000)).Id
        for (const [net, n] of others) await call(conn, 'POST', `${prefix}/networks/${encodeURIComponent(net)}/connect`, { Container: created, EndpointConfig: endpoint(n) }, true, 60_000)
        if (raw.State.Running) await call(conn, 'POST', `${prefix}/containers/${created}/start`, undefined, true, 60_000)
      }
      catch (err) {
        // Retour à l'ancien conteneur, intact.
        if (created) await call(conn, 'DELETE', `${prefix}/containers/${created}?force=true`, undefined, true, 60_000).catch(() => {})
        await call(conn, 'POST', `${prefix}/containers/${raw.Id}/rename?name=${encodeURIComponent(name)}`, undefined, true, 60_000).catch(() => {})
        if (raw.State.Running) await call(conn, 'POST', `${prefix}/containers/${raw.Id}/start`, undefined, true, 60_000).catch(() => {})
        throw err
      }
      await call(conn, 'DELETE', `${prefix}/containers/${raw.Id}?force=true&v=false`, undefined, true, 60_000).catch(() => {})
      return { id: created, name }
    },

    async signalContainer(conn, endpointId, containerId, signal) {
      await call(conn, 'POST', `${t.dockerPrefix(endpointId)}/containers/${encodeURIComponent(containerId)}/kill?signal=${signal}`, undefined, true, 60_000)
    },

    async openExec(conn, endpointId, containerId, o) {
      if (!t.interactive) throw new PortainerError('Terminal indisponible sur un hôte joint par l\'agent Portainer : utiliser une connexion SSH', 'unsupported')
      const prefix = t.dockerPrefix(endpointId)
      const created = await call<{ Id: string }>(conn, 'POST', `${prefix}/containers/${encodeURIComponent(containerId)}/exec`, {
        AttachStdin: true, AttachStdout: true, AttachStderr: true, Tty: true,
        Cmd: o.cmd, Env: ['TERM=xterm-256color'], ...(o.user ? { User: o.user } : {}),
      }, false, 30_000)
      const resize = async (cols: number, rows: number) => {
        await call(conn, 'POST', `${prefix}/exec/${created.Id}/resize?h=${Math.max(1, Math.floor(rows))}&w=${Math.max(1, Math.floor(cols))}`, undefined, true, 15_000)
      }
      const { base, dispatcher } = await t.target(conn).catch((err) => { throw classify(err) })
      // Le démarrage « détache » la connexion HTTP (Upgrade: tcp) : le socket devient le terminal.
      const upgraded = await new Promise<{ socket: import('node:stream').Duplex }>((resolve, reject) => {
        dispatcher.upgrade({
          origin: base,
          path: `${prefix}/exec/${created.Id}/start`,
          method: 'POST',
          protocol: 'tcp',
          headers: { ...t.headers(conn), 'Content-Type': 'application/json' },
          body: JSON.stringify({ Detach: false, Tty: true }),
          signal: AbortSignal.timeout(30_000),
        } as Parameters<typeof dispatcher.upgrade>[0], (err, data) => (err || !data ? reject(classify(err ?? new Error('Aucune réponse'))) : resolve({ socket: data.socket })))
      })
      // Taille initiale : la commande démarre avec le terminal déjà dimensionné.
      await resize(o.cols, o.rows).catch(() => undefined)
      return { stream: upgraded.socket, resize, close: () => upgraded.socket.destroy() }
    },

    async createVolume(conn, endpointId, spec) {
      const exists = await call(conn, 'GET', `${t.dockerPrefix(endpointId)}/volumes/${encodeURIComponent(spec.name)}`).then(() => true, (err: PortainerError) => {
        if (err.kind === 'not_found') return false
        throw err
      })
      if (!exists) await call(conn, 'POST', `${t.dockerPrefix(endpointId)}/volumes/create`, { Name: spec.name, Driver: spec.driver ?? 'local', Labels: spec.labels }, false, 60_000)
    },

    async pullImage(conn, endpointId, image, opts = {}) {
      await ensureImage(conn, endpointId, image, !!opts.force)
      const r = await call<{ Id: string }>(conn, 'GET', `${t.dockerPrefix(endpointId)}/images/${encodeURIComponent(image)}/json`)
      return { id: r.Id }
    },

    async createHolder(conn, endpointId, spec) {
      await ensureImage(conn, endpointId, spec.image)
      const created = await call<{ Id: string }>(conn, 'POST', `${t.dockerPrefix(endpointId)}/containers/create`, {
        Image: spec.image,
        Cmd: ['true'],
        Labels: spec.labels,
        NetworkDisabled: true,
        HostConfig: { Binds: spec.binds, NetworkMode: 'none', Privileged: false, SecurityOpt: ['no-new-privileges'] },
      }, false, 60_000)
      return created.Id
    },

    async openArchive(conn, endpointId, containerId, path, timeoutMs) {
      const target = await t.target(conn).catch((err) => { throw classify(err) })
      const res = await fetch(`${target.base}${t.dockerPrefix(endpointId)}/containers/${encodeURIComponent(containerId)}/archive?path=${encodeURIComponent(path)}`, {
        dispatcher: target.dispatcher,
        signal: AbortSignal.timeout(timeoutMs),
        headers: { ...t.headers(conn), 'Accept': 'application/x-tar' },
      }).catch((err) => { throw classify(err) })
      if (res.status === 404) throw new PortainerError(`Chemin introuvable : ${path}`, 'not_found', 404)
      if (!res.ok || !res.body) throw new PortainerError(`Lecture de ${path} impossible (${res.status}) : ${redactPatterns((await res.text().catch(() => '')).slice(0, 300))}`, 'http', res.status)
      // En-tête de Docker : stat du chemin (JSON en base64), bit 31 du mode = répertoire.
      let isDir = true
      try {
        const stat = JSON.parse(Buffer.from(res.headers.get('x-docker-container-path-stat') ?? '', 'base64').toString('utf8')) as { mode?: number }
        if (typeof stat.mode === 'number') isDir = (stat.mode & 0x80000000) !== 0
      }
      catch {
        // En-tête absent ou illisible : répertoire supposé.
      }
      const stream = Readable.fromWeb(res.body as import('node:stream/web').ReadableStream)
      stream.on('error', () => {})
      return { stream, isDir }
    },

    async putArchive(conn, endpointId, containerId, path, body, timeoutMs) {
      const target = await t.target(conn).catch((err) => { throw classify(err) })
      const res = await fetch(`${target.base}${t.dockerPrefix(endpointId)}/containers/${encodeURIComponent(containerId)}/archive?path=${encodeURIComponent(path)}`, {
        method: 'PUT',
        dispatcher: target.dispatcher,
        signal: AbortSignal.timeout(timeoutMs),
        headers: { ...t.headers(conn), 'Content-Type': 'application/x-tar' },
        body: body as unknown as ReadableStream,
        duplex: 'half',
      } as Parameters<typeof fetch>[1]).catch((err) => { throw classify(err) })
      if (!res.ok) throw new PortainerError(`Dépôt dans ${path} impossible (${res.status}) : ${redactPatterns((await res.text().catch(() => '')).slice(0, 300))}`, 'http', res.status)
      await res.body?.cancel().catch(() => {})
    },

    async runOneShot(conn, endpointId, spec) {
      const prefix = t.dockerPrefix(endpointId)
      const target = await t.target(conn).catch((err) => { throw classify(err) })
      const raw = (path: string, init: { method: string, body?: Buffer, headers?: Record<string, string>, timeoutMs: number }) =>
        fetch(`${target.base}${prefix}${path}`, {
          method: init.method,
          dispatcher: target.dispatcher,
          signal: AbortSignal.timeout(init.timeoutMs),
          headers: { ...t.headers(conn), ...init.headers },
          body: init.body,
        }).catch((err) => { throw classify(err) })

      await ensureImage(conn, endpointId, spec.image)

      const created = await call<{ Id: string }>(conn, 'POST', `${prefix}/containers/create`, {
        Image: spec.image,
        ...(spec.entrypoint ? { Entrypoint: spec.entrypoint } : {}),
        Cmd: spec.cmd,
        Labels: spec.labels,
        NetworkDisabled: !spec.networkMode,
        HostConfig: { Binds: spec.binds, NetworkMode: spec.networkMode ?? 'none', Privileged: false, SecurityOpt: ['no-new-privileges'], Memory: (spec.memoryMb ?? 512) * 1024 * 1024, PidsLimit: 256 },
      }, false, 60_000)
      const id = created.Id
      try {
        if (spec.files.length) {
          const p = pack()
          const chunks: Buffer[] = []
          p.on('data', (c: unknown) => {
            chunks.push(c as Buffer)
          })
          const ended = new Promise<void>(r => p.on('end', () => r()))
          for (const f of spec.files) p.entry({ name: f.path.replace(/^\/+/, ''), mode: f.mode ?? 0o600 }, f.content)
          p.finalize()
          await ended
          const put = await raw(`/containers/${id}/archive?path=/`, { method: 'PUT', body: Buffer.concat(chunks), headers: { 'Content-Type': 'application/x-tar' }, timeoutMs: 60_000 })
          if (!put.ok) throw new PortainerError(`Dépôt des fichiers d'entrée impossible (${put.status})`, 'http', put.status)
        }
        await call(conn, 'POST', `${prefix}/containers/${id}/start`, undefined, true, 60_000)
        const waited = await call<{ StatusCode: number }>(conn, 'POST', `${prefix}/containers/${id}/wait`, undefined, false, spec.timeoutMs)
        const logs = await this.containerLogs(conn, endpointId, id, 300).catch(() => [] as string[])
        const outputs: OneShotResult['outputs'] = {}
        for (const path of spec.outputs) outputs[path] = await this.readContainerFiles(conn, endpointId, id, path, spec.outputLimits)
        return { exitCode: waited.StatusCode, logs, outputs }
      }
      finally {
        await call(conn, 'DELETE', `${prefix}/containers/${id}?force=true&v=true`, undefined, true, 60_000).catch(() => {})
      }
    },

    async inspectConfig(conn, endpointId, containerId): Promise<ContainerConfig | null> {
      let i: {
        Id: string, Name: string, Image: string
        State: { Status: string }
        Config: { Image: string, Cmd: string[] | null, Entrypoint: string[] | string | null, WorkingDir: string, User: string, Env: string[] | null, Labels: Record<string, string> | null, ExposedPorts?: Record<string, unknown> | null, StopSignal?: string, Tty?: boolean, Healthcheck?: { Test?: string[], Interval?: number, Timeout?: number, Retries?: number, StartPeriod?: number } }
        HostConfig: { RestartPolicy?: { Name: string }, Privileged?: boolean, CapAdd?: string[] | null, CapDrop?: string[] | null, NetworkMode?: string, PortBindings?: Record<string, { HostIp: string, HostPort: string }[] | null> | null, ExtraHosts?: string[] | null }
        Mounts: { Type: string, Source?: string, Destination: string, RW: boolean, Name?: string }[]
        NetworkSettings: { Networks: Record<string, { Aliases?: string[] | null, DNSNames?: string[] | null, IPAMConfig?: { IPv4Address?: string } | null }> | null }
      }
      try {
        i = await docker(conn, endpointId, `/containers/${encodeURIComponent(containerId)}/json`)
      }
      catch (err) {
        if ((err as PortainerError).kind === 'not_found') return null
        throw err
      }
      const hc = i.Config.Healthcheck
      return {
        id: i.Id,
        name: i.Name.replace(/^\//, ''),
        image: i.Config.Image,
        imageId: i.Image,
        state: i.State.Status,
        entrypoint: i.Config.Entrypoint === null || i.Config.Entrypoint === undefined ? null : Array.isArray(i.Config.Entrypoint) ? i.Config.Entrypoint : [i.Config.Entrypoint],
        cmd: i.Config.Cmd ?? null,
        workingDir: i.Config.WorkingDir || null,
        user: i.Config.User || null,
        env: i.Config.Env ?? [],
        labels: i.Config.Labels ?? {},
        healthcheck: hc?.Test?.length ? { test: hc.Test, intervalNs: hc.Interval || null, timeoutNs: hc.Timeout || null, retries: hc.Retries || null, startPeriodNs: hc.StartPeriod || null } : null,
        restartPolicy: i.HostConfig.RestartPolicy?.Name || null,
        privileged: !!i.HostConfig.Privileged,
        capAdd: i.HostConfig.CapAdd ?? [],
        capDrop: i.HostConfig.CapDrop ?? [],
        networkMode: i.HostConfig.NetworkMode ?? null,
        portBindings: Object.entries(i.HostConfig.PortBindings ?? {}).flatMap(([container, b]) => (b?.length ? b.map(x => ({ container, hostIp: x.HostIp || null, hostPort: x.HostPort || null })) : [{ container, hostIp: null, hostPort: null }])),
        exposedPorts: Object.keys(i.Config.ExposedPorts ?? {}),
        mounts: i.Mounts.map(m => ({ type: m.Type, source: m.Source ?? null, destination: m.Destination, rw: m.RW, name: m.Name ?? null })),
        networks: Object.entries(i.NetworkSettings.Networks ?? {}).map(([name, n]) => ({ name, aliases: [...new Set([...(n.Aliases ?? []), ...(n.DNSNames ?? [])])], staticIp: n.IPAMConfig?.IPv4Address || null })),
        extraHosts: i.HostConfig.ExtraHosts ?? [],
        stopSignal: i.Config.StopSignal || null,
        tty: !!i.Config.Tty,
      }
    },

    async imageConfig(conn, endpointId, image) {
      try {
        const i = await docker<{ Config?: { Env?: string[] | null, Cmd?: string[] | null, Entrypoint?: string[] | string | null, WorkingDir?: string, User?: string, Labels?: Record<string, string> | null, Healthcheck?: { Test?: string[] } | null } }>(conn, endpointId, `/images/${encodeURIComponent(image)}/json`)
        const c = i.Config ?? {}
        return {
          env: c.Env ?? [],
          cmd: c.Cmd ?? null,
          entrypoint: c.Entrypoint === null || c.Entrypoint === undefined ? null : Array.isArray(c.Entrypoint) ? c.Entrypoint : [c.Entrypoint],
          workingDir: c.WorkingDir || null,
          user: c.User || null,
          labels: c.Labels ?? {},
          healthcheck: c.Healthcheck?.Test ?? null,
        }
      }
      catch (err) {
        if ((err as PortainerError).kind === 'not_found') return null
        throw err
      }
    },

    async imageInfo(conn, endpointId, imageId) {
      try {
        const i = await docker<{ Id: string, RepoDigests: string[] | null, Created: string | null }>(conn, endpointId, `/images/${encodeURIComponent(imageId)}/json`)
        return { id: i.Id, repoDigests: i.RepoDigests ?? [], created: i.Created ?? null }
      }
      catch (err) {
        if ((err as PortainerError).kind === 'not_found') return null
        throw err
      }
    },
  }
}
