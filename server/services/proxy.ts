/**
 * Lecture des reverse proxies d'un endpoint (lecture seule, via l'API Docker
 * de Portainer) : configuration effective de Traefik (fichier, arguments ou
 * variables TRAEFIK_*), fournisseur fichier, configuration nginx/Caddy, puis
 * carte des expositions. Les fichiers et valeurs lus restent en mémoire le
 * temps de l'analyse : seuls des noms, adresses et chemins en sortent.
 */
import { posix } from 'node:path'
import { and, eq, isNull } from 'drizzle-orm'
import { createError } from 'h3'
import type { ProxyKind, ProxyTopology, TraefikStatic, TraefikSuggestion } from '../../shared/schemas/proxy'
import type { PortainerConnection } from '../adapters/portainer/types'
import { portainer } from '../adapters/portainer'
import { db, schema } from '../db/client'
import { type Flat, ConfigParseError, flatFromArgs, flatFromEnv, flatten, parseConfigFile, str } from '../lib/proxy/flat'
import { CONFIG_PATHS, NGINX_KINDS, parseCaddyfile, parseNginx, proxyKindOf } from '../lib/proxy/others'
import { type CandidateInput, suggestProxyConfig } from '../lib/proxy/suggest'
import { type ProbedProxy, type TopoContainer, type VirtualHost, buildTopology } from '../lib/proxy/topology'
import { DEFAULT_CONFIG_PATHS, type Dynamic, interpretDynamic, interpretStatic, traefikArgs } from '../lib/proxy/traefik'
import { type Progress, noProgress } from '../utils/progress'
import { redactPatterns } from '../utils/redact'
import type { EndpointRow } from './live'
import { connectionFor } from './servers'

const TTL_MS = 30_000
const FILE_LIMITS = { maxBytes: 256 * 1024, maxFiles: 1 }
const DIR_LIMITS = { maxBytes: 1024 * 1024, maxFiles: 50 }
const cache = new Map<string, { at: number, value: Promise<ProxyTopology> }>()

const errMsg = (err: unknown) => redactPatterns((err as Error).message ?? String(err)).slice(0, 300)

type Reader = (path: string, dir?: boolean) => Promise<{ path: string, content: string }[] | null>

async function probeTraefik(c: TopoContainer, conn: PortainerConnection, epId: number, read: Reader): Promise<ProbedProxy> {
  const warnings: string[] = []
  const configFiles: string[] = []
  const cfg = await portainer().inspectConfig(conn, epId, c.id)
  const args = traefikArgs(cfg?.entrypoint ?? [], cfg?.cmd ?? [])
  // Seules les variables TRAEFIK_* sont interprétées ; aucune autre n'est conservée.
  const tEnv = Object.fromEntries((cfg?.env ?? []).map(e => [e.slice(0, e.indexOf('=')), e.slice(e.indexOf('=') + 1)] as const).filter(([k]) => /^TRAEFIK_/i.test(k)))
  const cli = flatFromArgs(args)
  const envFlat = flatFromEnv(tEnv)
  const wd = cfg?.workingDir ?? '/'
  const explicit = str(cli.get('configfile')) ?? str(envFlat.get('configfile'))
  const candidates = explicit
    ? [posix.resolve(wd, explicit)]
    : [...DEFAULT_CONFIG_PATHS, ...['traefik.yml', 'traefik.yaml', 'traefik.toml'].map(f => posix.join(wd, f))]

  // Traefik retient le premier fichier trouvé ; à défaut les arguments, puis les variables.
  let flat: Flat | null = null
  let source: TraefikStatic['source'] = 'defaults'
  let configFile: string | null = null
  for (const path of [...new Set(candidates)]) {
    const files = await read(path).catch((err) => {
      warnings.push(`Lecture de ${path} impossible : ${errMsg(err)}`)
      return null
    })
    if (!files?.length) continue
    try {
      flat = flatten(parseConfigFile(path, files[0]!.content))
      source = 'file'
      configFile = path
      configFiles.push(path)
    }
    catch (err) {
      warnings.push(`${path} : ${err instanceof ConfigParseError ? err.message : 'format illisible'}`)
    }
    break
  }
  if (!flat && explicit && !configFile) warnings.push(`Fichier de configuration ${explicit} introuvable`)
  if (!flat && args.length) {
    flat = cli
    source = 'cli'
  }
  if (!flat && envFlat.size) {
    flat = envFlat
    source = 'env'
  }
  const st = interpretStatic(flat ?? new Map(), source, configFile)
  if (source === 'file' && args.some(a => !/^--configfile=/i.test(a))) st.warnings.push('Un fichier de configuration est présent : Traefik ignore les arguments de lancement')

  // Fournisseur fichier : routeurs, services, middlewares, TLS.
  const dynamic: Dynamic[] = []
  const fp = st.providers.file
  if (fp) {
    const targets = [fp.filename && { path: posix.resolve(wd, fp.filename), dir: false }, fp.directory && { path: posix.resolve(wd, fp.directory), dir: true }].filter(Boolean) as { path: string, dir: boolean }[]
    for (const t of targets) {
      const files = await read(t.path, t.dir).catch((err) => {
        warnings.push(`Lecture de ${t.path} impossible : ${errMsg(err)}`)
        return null
      })
      if (!files) {
        warnings.push(`Configuration dynamique ${t.path} introuvable`)
        continue
      }
      for (const f of files.filter(x => /\.(ya?ml|toml)$/i.test(x.path))) {
        configFiles.push(f.path)
        try {
          dynamic.push(interpretDynamic(flatten(parseConfigFile(f.path, f.content))))
        }
        catch (err) {
          warnings.push(`${f.path} : ${err instanceof ConfigParseError ? err.message : 'format illisible'}${f.content.includes('{{') ? ' (gabarit Go non interprété)' : ''}`)
        }
      }
    }
  }
  return { kind: 'traefik', containerId: c.id, static: st, dynamic, sites: [], configFiles, warnings }
}

type ManagedNginx = NonNullable<ProbedProxy['managed']>

async function probeOther(kind: ProbedProxy['kind'], c: TopoContainer, read: Reader, managed: ManagedNginx | null): Promise<ProbedProxy> {
  const warnings: string[] = []
  const configFiles: string[] = []
  const sites: ProbedProxy['sites'] = []
  const certs = new Set<string>()
  const nginx = NGINX_KINDS.includes(kind)
  // nginx déclaré : son dossier des configurations (fichiers écrits par la console) en plus des chemins usuels.
  const paths = [...new Set([...(CONFIG_PATHS[kind] ?? []), ...(managed?.confDir && kind !== 'nginx-proxy' ? [managed.confDir] : [])])]
  const seen = new Set<string>()
  for (const path of paths) {
    const isFile = /(Caddyfile|\.conf)$/.test(path)
    const files = await read(path, !isFile).catch((err) => {
      warnings.push(`Lecture de ${path} impossible : ${errMsg(err)}`)
      return null
    })
    for (const f of files ?? []) {
      if (seen.has(f.path)) continue
      seen.add(f.path)
      if (kind === 'caddy') {
        configFiles.push(f.path)
        sites.push(...parseCaddyfile(f.content))
      }
      else if (/\.conf$/.test(f.path)) {
        configFiles.push(f.path)
        sites.push(...parseNginx(f.content, f.path))
        for (const m of f.content.matchAll(/^\s*ssl_certificate\s+([^;\s]+)\s*;/gm)) certs.add(m[1]!)
      }
    }
  }
  if (!paths.length && kind !== 'caddy-docker-proxy' && kind !== 'nginx-proxy') warnings.push('Configuration non analysée pour ce type de proxy')
  if (nginx && !sites.length && kind !== 'nginx-proxy' && configFiles.length) warnings.push('Aucun bloc server avec proxy_pass dans la configuration lue')
  return { kind, containerId: c.id, static: null, dynamic: [], sites, configFiles, warnings, managed, ...(nginx ? { certificateFiles: certs.size } : {}) }
}

/** Variables lues sur les conteneurs servis par nginx-proxy (liste blanche, rien d'autre). */
const VIRTUAL_VARS = new Set(['VIRTUAL_HOST', 'VIRTUAL_PORT', 'VIRTUAL_PATH', 'HTTPS_METHOD'])

async function virtualHosts(proxy: TopoContainer, containers: readonly TopoContainer[], conn: PortainerConnection, epId: number): Promise<VirtualHost[]> {
  const nets = new Set(proxy.networks.filter(n => !['bridge', 'host', 'none'].includes(n)))
  const served = containers.filter(c => c.id !== proxy.id && c.networks.some(n => nets.has(n)))
  const out: VirtualHost[] = []
  // Inspections bornées (connexions SSH limitées).
  for (let i = 0; i < served.length; i += 4) {
    const batch = await Promise.all(served.slice(i, i + 4).map(async (c) => {
      const cfg = await portainer().inspectConfig(conn, epId, c.id).catch(() => null)
      const env = new Map((cfg?.env ?? []).map(e => [e.slice(0, e.indexOf('=')), e.slice(e.indexOf('=') + 1)] as const).filter(([k]) => VIRTUAL_VARS.has(k)))
      const hosts = (env.get('VIRTUAL_HOST') ?? '').split(',').map(h => h.trim().toLowerCase()).filter(Boolean)
      if (!hosts.length) return null
      const port = Number(env.get('VIRTUAL_PORT'))
      const path = env.get('VIRTUAL_PATH')?.trim() || null
      return { containerId: c.id, hosts, port: Number.isInteger(port) && port > 0 ? port : null, path: path && path !== '/' ? path : null, httpsMethod: env.get('HTTPS_METHOD')?.trim() || null }
    }))
    out.push(...batch.filter((x): x is VirtualHost => !!x))
  }
  return out
}

/** Fichiers révélant la techno d'un conteneur publiant 80/443 dont l'image n'est pas reconnue. */
const PROBES: { path: string, kind: ProxyKind }[] = [
  { path: '/etc/nginx/nginx.conf', kind: 'nginx' },
  { path: '/usr/local/openresty/nginx/conf/nginx.conf', kind: 'nginx' },
  { path: '/etc/caddy/Caddyfile', kind: 'caddy' },
  { path: '/usr/local/etc/haproxy/haproxy.cfg', kind: 'haproxy' },
  { path: '/usr/local/apache2/conf/httpd.conf', kind: 'httpd' },
]

/** Techno d'un conteneur d'après la présence de son fichier de configuration (contenu ignoré). */
async function probeKind(conn: PortainerConnection, epId: number, containerId: string): Promise<ProxyKind | null> {
  for (const probe of PROBES) {
    const found = await portainer().readContainerFiles(conn, epId, containerId, probe.path, { maxBytes: 256 * 1024, maxFiles: 1 }).catch(() => null)
    if (found?.length) return probe.kind
  }
  return null
}

const publishesWeb = (c: { ports: { privatePort: number, publicPort: number | null }[] }) => c.ports.some(x => x.publicPort && [80, 443].some(n => n === x.privatePort || n === x.publicPort))

/** Reverse proxies nginx déclarés pour l'endpoint (conteneur, provider, dossiers, réseau). */
async function declaredNginx(endpointId: string): Promise<Map<string, ManagedNginx>> {
  const rows = await db().select().from(schema.traefikConfigs).where(eq(schema.traefikConfigs.endpointId, endpointId))
  const out = new Map<string, ManagedNginx>()
  for (const r of rows) {
    if (r.provider === 'traefik' || !r.nginxContainer || out.has(r.nginxContainer)) continue
    out.set(r.nginxContainer, {
      provider: r.provider,
      confDir: r.provider === 'nginx' ? r.nginxConfDir : null,
      certsDir: r.provider === 'nginx-proxy' ? '/etc/nginx/certs' : r.nginxCertsDir,
      acme: !!r.nginxAcmeEmail,
      network: r.networkName,
    })
  }
  return out
}

async function scan(row: EndpointRow, progress: Progress): Promise<ProxyTopology> {
  const conn = await connectionFor(row.server)
  const p = portainer()
  const epId = row.ep.portainerEndpointId
  await progress.step('Lecture des conteneurs', 1, 3)
  const raw = await p.listContainers(conn, epId)
  const containers: TopoContainer[] = raw.map(c => ({ id: c.id, name: c.names[0] ?? c.id.slice(0, 12), image: c.image, state: c.state, labels: c.labels, networks: c.networks, ports: c.ports ?? [] }))
  const declared = await declaredNginx(row.ep.id)
  const nameOf = (c: TopoContainer) => c.name.replace(/^\//, '')
  // Proxy reconnu par son image, nginx déclaré dans la plateforme, ou conteneur publiant 80/443
  // dont la configuration révèle la techno (image personnalisée).
  const candidates = (await Promise.all(containers.map(async (c) => {
    const managed = declared.get(nameOf(c)) ?? null
    let kind = proxyKindOf(c.image, c.ports.filter(x => x.publicPort).map(x => x.privatePort))
    if (managed && (!kind || !NGINX_KINDS.includes(kind))) kind = managed.provider
    if (!kind && c.state === 'running' && publishesWeb(c)) kind = await probeKind(conn, epId, c.id)
    return kind ? { c, kind, managed } : null
  }))).filter((x): x is { c: TopoContainer, kind: ProxyKind, managed: ManagedNginx | null } => !!x)

  await progress.step(candidates.length ? `Lecture de la configuration de ${candidates.length} proxy(s)` : 'Aucun proxy détecté', 2, 3)
  const probes: ProbedProxy[] = []
  for (const { c, kind, managed } of candidates) {
    const read: Reader = (path, dir) => p.readContainerFiles(conn, epId, c.id, path, dir ? DIR_LIMITS : FILE_LIMITS)
    try {
      if (kind === 'traefik') probes.push(await probeTraefik(c, conn, epId, read))
      else {
        const probe = await probeOther(kind, c, read, managed)
        if (kind === 'nginx-proxy') probe.virtualHosts = await virtualHosts(c, containers, conn, epId)
        probes.push(probe)
      }
    }
    catch (err) {
      probes.push({ kind, containerId: c.id, static: kind === 'traefik' ? interpretStatic(new Map(), 'defaults', null) : null, dynamic: [], sites: [], configFiles: [], warnings: [`Lecture impossible : ${errMsg(err)}`], managed })
    }
  }
  await progress.step('Carte des expositions', 3, 3)
  return buildTopology(row.ep.id, containers, probes)
}

/** Lecture suivante refaite (configuration du reverse proxy changée). */
export function invalidateTopology(endpointId: string): void {
  cache.delete(endpointId)
}

export function endpointTopology(row: EndpointRow, opts: { refresh?: boolean, progress?: Progress } = {}): Promise<ProxyTopology> {
  const hit = cache.get(row.ep.id)
  if (!opts.refresh && hit && Date.now() - hit.at < TTL_MS) return hit.value
  const value = scan(row, opts.progress ?? noProgress)
  cache.set(row.ep.id, { at: Date.now(), value })
  value.catch(() => cache.delete(row.ep.id))
  return value
}

export async function endpointSuggestion(row: EndpointRow, progress: Progress = noProgress, pick?: string): Promise<TraefikSuggestion> {
  const topo = await endpointTopology(row, { progress })
  const nets = await db().select({ name: schema.networks.name, policy: schema.networks.policy, missing: schema.networks.missing }).from(schema.networks).where(eq(schema.networks.endpointId, row.ep.id))
  const [current] = await db().select({ allowedDomains: schema.traefikConfigs.allowedDomains }).from(schema.traefikConfigs)
    .where(and(eq(schema.traefikConfigs.endpointId, row.ep.id), isNull(schema.traefikConfigs.environmentId)))
  await progress.step('Recherche des conteneurs publiant 80/443')
  const containers = await portainer().listContainers(await connectionFor(row.server), row.ep.portainerEndpointId)
  // Techno des images non reconnues : déjà lue par la topologie (configuration présente dans le conteneur).
  const inputs: CandidateInput[] = containers.map(c => ({
    id: c.id,
    name: (c.names[0] ?? c.id.slice(0, 12)).replace(/^\//, ''),
    image: c.image,
    running: c.state === 'running',
    networks: c.networks,
    ports: (c.ports ?? []).map(x => ({ ip: x.ip, privatePort: x.privatePort, publicPort: x.publicPort })),
    probedKind: null,
  }))
  return suggestProxyConfig(topo, nets, current?.allowedDomains ?? [], inputs, pick)
}

/**
 * Rebranche un conteneur derrière Traefik : connecté au réseau par lequel Traefik doit le joindre
 * (avec ses noms DNS), puis redémarré — Traefik ne prend en compte que les démarrages de conteneurs,
 * pas les connexions réseau. Seul ce conteneur redémarre (ni Traefik, ni les autres sites).
 */
export async function reattachBehindTraefik(row: EndpointRow, containerId: string, network: string, restart: boolean): Promise<string[]> {
  const conn = await connectionFor(row.server)
  const p = portainer()
  const epId = row.ep.portainerEndpointId
  const containers = await p.listContainers(conn, epId)
  const c = containers.find(x => x.id === containerId || x.id.startsWith(containerId))
  if (!c) throw createError({ statusCode: 404, statusMessage: 'Conteneur introuvable sur l\'hôte' })
  // Proxy détecté (Traefik, nginx…) branché sur ce réseau.
  const proxies = (await endpointTopology(row)).proxies
  if (!proxies.some(x => x.networks.includes(network)) && !containers.some(x => /(^|\/)traefik(:|@|$)/i.test(x.image) && x.networks.includes(network))) {
    throw createError({ statusCode: 422, statusMessage: `Aucun reverse proxy branché sur le réseau ${network}` })
  }
  const name = c.names[0]!.replace(/^\//, '')
  const log: string[] = []
  if (c.networks.includes(network)) log.push(`${name} déjà sur ${network}`)
  else {
    const aliases = [c.labels['com.docker.compose.service'], name].filter((x): x is string => !!x)
    await p.connectNetwork(conn, epId, network, c.id, aliases)
    log.push(`${name} connecté à ${network} (noms : ${aliases.join(', ')})`)
  }
  if (restart) {
    await p.restartContainer(conn, epId, c.id)
    log.push(`${name} redémarré : le proxy relit sa route`)
  }
  cache.delete(row.ep.id)
  return log
}
