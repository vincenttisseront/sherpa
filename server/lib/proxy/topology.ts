/**
 * Carte des expositions d'un endpoint : quel domaine mène à quel conteneur,
 * par quel proxy, point d'entrée, TLS et réseau. Fonction pure : les
 * lectures Docker sont faites en amont (services/proxy.ts).
 */
import type { DetectedProxy, NginxListen, NginxStatic, ProxyKind, ProxyRoute, ProxyTopology, TraefikStatic } from '../../../shared/schemas/proxy'
import { aliasFor } from '../compose/unique-aliases'
import { flatFromLabels } from './flat'
import { NGINX_KINDS, type SiteRoute, caddyLabelRoutes, parseUpstream } from './others'
import { type Dynamic, type DynRouter, interpretDynamic, parseRule, versionFromImage } from './traefik'

export interface TopoContainer {
  id: string
  name: string
  image: string
  state: string
  labels: Record<string, string>
  networks: string[]
  ports: { ip: string | null, privatePort: number, publicPort: number | null, type: string }[]
}

export interface ProbedProxy {
  kind: ProxyKind
  containerId: string
  static: TraefikStatic | null
  /** Configuration dynamique du fournisseur fichier. */
  dynamic: Dynamic[]
  /** Sites lus dans la configuration (nginx, Caddy). */
  sites: SiteRoute[]
  configFiles: string[]
  warnings: string[]
  /** nginx déclaré comme reverse proxy des projets dans la plateforme. */
  managed?: NginxStatic['managed']
  /** nginx-proxy : variables VIRTUAL_* des conteneurs servis (lues par liste blanche). */
  virtualHosts?: VirtualHost[]
  /** nginx : certificats distincts référencés (ssl_certificate). */
  certificateFiles?: number
}

export interface VirtualHost { containerId: string, hosts: string[], port: number | null, path: string | null, httpsMethod: string | null }

const PLATFORM_FILE_RE = /(^|\/)platform-[^/]+\.conf$/
const SIMPLE_HOST_RE = /^[a-z0-9][a-z0-9.-]*$/i

const SYSTEM_NETWORKS = new Set(['bridge', 'host', 'none'])
const stackOf = (c: TopoContainer) => c.labels['com.docker.compose.project'] ?? null
const serviceOf = (c: TopoContainer) => c.labels['com.docker.compose.service'] ?? null

function ref(c: TopoContainer): ProxyRoute['container'] {
  return { id: c.id, name: c.name, stack: stackOf(c), service: serviceOf(c), managed: c.labels['platform.managed'] === 'true' }
}

/**
 * Conteneur désigné par un hôte d'URL : nom, service Compose ou identifiant court.
 * Un nom de service n'est résolu que sur les réseaux du proxy (là où Docker le résout).
 */
function containerByHost(containers: readonly TopoContainer[], host: string, proxyNets: ReadonlySet<string>, aliases?: ReadonlyMap<string, TopoContainer>): TopoContainer | null {
  const h = host.toLowerCase()
  const byName = containers.find(c => c.name.toLowerCase() === h)
  if (byName) return byName
  // Alias unique de la plateforme (« <stack>-<service> ») sur le réseau du proxy.
  const byAlias = aliases?.get(h)
  if (byAlias) return byAlias
  const bySvc = containers.filter(c => serviceOf(c)?.toLowerCase() === h)
  const reachable = bySvc.filter(c => c.networks.some(n => proxyNets.has(n)))
  if (reachable.length === 1) return reachable[0]!
  if (!reachable.length && bySvc.length === 1) return bySvc[0]!
  return containers.find(c => c.id.startsWith(h) && h.length >= 12) ?? null
}

/**
 * Contrainte du fournisseur Docker de Traefik (Label, LabelRegex, !, &&, ||,
 * parenthèses) évaluée sur les labels d'un conteneur ; null si non interprétable.
 */
export function evalConstraint(expr: string, labels: Record<string, string>): boolean | null {
  const tokens = expr.match(/LabelRegex\(\s*`[^`]*`\s*,\s*`[^`]*`\s*\)|Label\(\s*`[^`]*`\s*,\s*`[^`]*`\s*\)|&&|\|\||!|\(|\)|\S+/g) ?? []
  let i = 0
  const fail = Symbol('fail')
  type R = boolean | typeof fail
  const primary = (): R => {
    const t = tokens[i++]
    if (t === undefined) return fail
    if (t === '!') {
      const v = primary()
      return v === fail ? fail : !v
    }
    if (t === '(') {
      const v = or()
      return tokens[i++] === ')' ? v : fail
    }
    const m = /^(Label|LabelRegex)\(\s*`([^`]*)`\s*,\s*`([^`]*)`\s*\)$/.exec(t)
    if (!m) return fail
    const v = labels[m[2]!]
    if (m[1] === 'Label') return v === m[3]
    try {
      return v !== undefined && new RegExp(m[3]!).test(v)
    }
    catch {
      return fail
    }
  }
  const and = (): R => {
    let v = primary()
    while (tokens[i] === '&&') {
      i++
      const w = primary()
      v = v === fail || w === fail ? fail : v && w
    }
    return v
  }
  function or(): R {
    let v = and()
    while (tokens[i] === '||') {
      i++
      const w = and()
      v = v === fail || w === fail ? fail : v || w
    }
    return v
  }
  const v = or()
  return v === fail || i !== tokens.length ? null : v
}

const withProvider = (name: string, provider: string) => (name.includes('@') ? name : `${name}@${provider}`)

/** Écoutes d'un nginx : ports des blocs server (sinon ports 80/443 publiés), TLS et redirection. */
function nginxListens(p: ProbedProxy, c: TopoContainer, hostPorts: DetectedProxy['hostPorts']): NginxListen[] {
  const ports = new Set<number>(p.sites.flatMap(s => s.listens ?? []))
  if (!ports.size) for (const x of c.ports) if (x.type === 'tcp' && (x.privatePort === 80 || x.privatePort === 443)) ports.add(x.privatePort)
  return [...ports].sort((a, b) => a - b).map((port) => {
    const on = p.sites.filter(s => s.listens?.includes(port))
    const tls = on.length ? on.some(s => s.tls && !s.redirect) : port === 443
    const redirect = !tls && on.length > 0 && on.every(s => s.redirect)
    return { port, tls, redirectTo: redirect ? (ports.has(443) ? ':443' : 'https') : null, hostPorts: hostPorts.filter(h => h.container === port && h.protocol === 'tcp').map(h => h.host) }
  })
}

export function buildTopology(endpointId: string, containers: readonly TopoContainer[], probes: readonly ProbedProxy[]): ProxyTopology {
  const routes: ProxyRoute[] = []
  const middlewares: ProxyTopology['middlewares'] = []
  const warnings: string[] = []
  const byId = new Map(containers.map(c => [c.id, c]))
  const aliases = new Map(containers.filter(c => stackOf(c) && serviceOf(c)).map(c => [aliasFor(stackOf(c)!, serviceOf(c)!), c] as const))

  const proxies: DetectedProxy[] = probes.map((p) => {
    const c = byId.get(p.containerId)!
    const hostPorts = c.ports.filter(x => x.publicPort).map(x => ({ container: x.privatePort, host: `${x.ip && x.ip !== '0.0.0.0' && x.ip !== '::' ? x.ip : '0.0.0.0'}:${x.publicPort}`, protocol: x.type }))
    if (p.static) {
      for (const e of p.static.entrypoints) e.hostPorts = hostPorts.filter(h => h.container === e.port && h.protocol === e.protocol).map(h => h.host)
    }
    return {
      kind: p.kind,
      container: { id: c.id, name: c.name, image: c.image, stack: stackOf(c), running: c.state === 'running' },
      version: versionFromImage(c.image),
      networks: c.networks.filter(n => !SYSTEM_NETWORKS.has(n)),
      hostPorts,
      traefik: p.static,
      nginx: NGINX_KINDS.includes(p.kind)
        ? {
            managed: p.managed ?? null,
            listens: nginxListens(p, c, hostPorts),
            sites: p.virtualHosts ? p.virtualHosts.length : new Set(p.sites.map(s => `${s.file ?? ''}|${s.site}|${(s.listens ?? []).join(',')}`)).size,
            platformSites: new Set(p.sites.filter(s => s.file && PLATFORM_FILE_RE.test(s.file)).map(s => s.file)).size,
            certificateFiles: p.certificateFiles ?? 0,
          }
        : null,
      tlsOptions: p.dynamic.flatMap(d => d.tlsOptions),
      certificates: { files: p.dynamic.reduce((a, d) => a + d.certificates.files, 0), defaultCertificate: p.dynamic.some(d => d.certificates.defaultCertificate) },
      configFiles: p.configFiles,
      managedByPlatform: p.kind === 'traefik' || !!p.managed,
      warnings: [...p.warnings, ...(p.static?.warnings ?? [])],
    }
  })

  // --- Traefik ---
  const traefiks = probes.filter(p => p.kind === 'traefik' && p.static)
  // Labels Docker : chaque conteneur est servi par le premier Traefik (fournisseur Docker)
  // dont la contrainte l'accepte, de préférence un Traefik joignable par un réseau commun.
  const dockerTraefiks = traefiks.filter(p => p.static!.providers.docker?.enabled)
  const ownerOf = new Map<string, ProbedProxy>()
  for (const p of dockerTraefiks) {
    const expr = p.static!.providers.docker!.constraints
    if (expr && evalConstraint(expr, {}) === null) warnings.push(`Contrainte du fournisseur Docker non évaluée : ${expr}`)
  }
  for (const c of containers) {
    const eligible = dockerTraefiks.filter((p) => {
      const expr = p.static!.providers.docker!.constraints
      return !expr || evalConstraint(expr, c.labels) !== false
    })
    const reachable = eligible.find((p) => {
      const t = byId.get(p.containerId)!
      return t.id === c.id || c.networks.some(n => !SYSTEM_NETWORKS.has(n) && t.networks.includes(n))
    })
    const owner = reachable ?? eligible[0]
    if (owner) ownerOf.set(c.id, owner)
  }
  const labelMw = new Map<string, string>()
  const labelDyn = new Map<string, Dynamic>()
  if (dockerTraefiks.length) {
    for (const c of containers) {
      if (!Object.keys(c.labels).some(k => k.toLowerCase().startsWith('traefik.'))) continue
      const d = interpretDynamic(flatFromLabels(c.labels, 'traefik.'))
      labelDyn.set(c.id, d)
      for (const m of d.middlewares) {
        labelMw.set(m.name, m.type)
        middlewares.push({ name: `${m.name}@docker`, type: m.type, provider: c.name })
      }
    }
  }
  const fileMw = new Map<string, string>()
  for (const p of traefiks) {
    for (const d of p.dynamic) {
      for (const m of d.middlewares) {
        fileMw.set(m.name, m.type)
        middlewares.push({ name: `${m.name}@file`, type: m.type, provider: 'fichier' })
      }
    }
  }
  const mwType = (name: string, provider: 'docker' | 'file') => {
    const [n, prov] = name.split('@') as [string, string | undefined]
    return (prov ?? provider) === 'file' ? fileMw.get(n) : labelMw.get(n)
  }

  function routeFrom(st: TraefikStatic, r: DynRouter, provider: 'docker' | 'file'): ProxyRoute {
    const httpEps = st.entrypoints.filter(e => e.protocol === (r.kind === 'udp' ? 'udp' : 'tcp'))
    const epNames = r.entrypoints.length ? r.entrypoints : httpEps.map(e => e.name)
    const eps = epNames.map(n => st.entrypoints.find(e => e.name === n))
    const known = eps.filter((e): e is NonNullable<typeof e> => !!e)
    const w: string[] = []
    for (const [i, e] of eps.entries()) if (!e) w.push(`Point d'entrée « ${epNames[i]} » inconnu`)
    // Les points d'entrée qui redirigent ne servent pas la route : le TLS se juge sur les autres.
    const served = known.filter(e => !e.redirectTo)
    const tls = r.tls || (served.length > 0 && served.every(e => e.tls))
    const certResolver = r.certResolver ?? served.find(e => e.certResolver)?.certResolver ?? null
    if (certResolver && !st.certResolvers.some(x => x.name === certResolver)) w.push(`Résolveur de certificats « ${certResolver} » inconnu`)
    const allMw = [...known.flatMap(e => e.middlewares), ...r.middlewares]
    const redirectsToHttps = known.some(e => !!e.redirectTo) || allMw.some(m => mwType(m, provider) === 'redirectscheme')
    if (r.kind === 'http' && !tls && !redirectsToHttps) w.push('Servi en HTTP sans TLS ni redirection')
    const parsed = parseRule(r.rule)
    return {
      router: withProvider(r.name, provider),
      proxyId: '',
      provider,
      kind: r.kind,
      rule: r.rule,
      hosts: parsed.hosts,
      pathPrefix: parsed.pathPrefix,
      entrypoints: epNames,
      tls,
      certResolver: tls ? certResolver : null,
      tlsOptions: r.tlsOptions,
      passthrough: r.passthrough,
      redirectsToHttps,
      middlewares: r.middlewares,
      service: r.service,
      container: null,
      targetPort: null,
      targetUrl: null,
      network: null,
      convertible: false,
      warnings: w,
    }
  }

  for (const p of traefiks) {
    const st = p.static!
    const traefik = byId.get(p.containerId)!
    const traefikNets = new Set(traefik.networks.filter(n => !SYSTEM_NETWORKS.has(n)))

    // Labels Docker.
    if (st.providers.docker?.enabled) {
      const dp = st.providers.docker
      for (const c of containers.filter(x => ownerOf.get(x.id) === p)) {
        const hasLabels = labelDyn.has(c.id)
        const enable = c.labels['traefik.enable']
        const enabled = enable === 'true' || (dp.exposedByDefault && enable !== 'false')
        if (!enabled) {
          if (hasLabels && enable !== 'false' && c.id !== traefik.id) warnings.push(`${c.name} : labels Traefik ignorés (traefik.enable absent alors que exposedByDefault est désactivé)`)
          continue
        }
        const d = labelDyn.get(c.id) ?? interpretDynamic(new Map())
        // Service implicite : port exposé unique.
        const privatePorts = [...new Set(c.ports.filter(x => x.type === 'tcp').map(x => x.privatePort))]
        const implicitPort = privatePorts.length === 1 ? privatePorts[0]! : null
        let routers = d.routers
        if (!routers.length) {
          if (c.id === traefik.id) continue
          routers = [{ name: c.name, kind: 'http', rule: null, entrypoints: [], tls: false, certResolver: null, tlsOptions: null, passthrough: false, middlewares: [], service: null }]
        }
        // Réseau utilisé par Traefik pour joindre le conteneur.
        const wanted = c.labels['traefik.docker.network'] ?? dp.network
        const shared = c.networks.filter(n => traefikNets.has(n))
        let network: string | null = null
        const netWarn: string[] = []
        // Réparation : réseau à rejoindre, quand il est déterminé sans ambiguïté et que Traefik y est branché.
        let reattach: { network: string, reason: string } | null = null
        const fallback = [wanted, dp.network].find(n => n && traefikNets.has(n)) ?? (traefikNets.size === 1 ? [...traefikNets][0]! : null)
        if (c.id !== traefik.id && wanted && !c.networks.includes(wanted) && traefikNets.has(wanted)) reattach = { network: wanted, reason: `Réseau « ${wanted} » demandé (traefik.docker.network) mais le conteneur n'y est pas attaché` }
        else if (c.id !== traefik.id && !shared.length && fallback) reattach = { network: fallback, reason: 'Aucun réseau commun avec Traefik' }
        if (c.id === traefik.id) network = null
        else if (wanted && c.networks.includes(wanted)) network = wanted
        else if (shared.length) {
          network = shared[0]!
          if (wanted) netWarn.push(`Réseau « ${wanted} » demandé mais le conteneur n'y est pas attaché`)
          else if (shared.length > 1) netWarn.push(`Plusieurs réseaux communs avec Traefik (${shared.join(', ')}) sans traefik.docker.network : choix aléatoire`)
        }
        else netWarn.push('Aucun réseau commun avec Traefik : la route ne peut pas fonctionner')
        for (const r of routers) {
          const route = routeFrom(st, r, 'docker')
          route.proxyId = p.containerId
          const svcName = r.service?.replace(/@docker$/, '') ?? null
          const svc = svcName ? d.services.find(s => s.name === svcName) : d.services.length === 1 ? d.services[0] : null
          const external = !!r.service && r.service.includes('@') && !r.service.endsWith('@docker')
          route.service = r.service ?? svc?.name ?? null
          if (!external) {
            route.container = ref(c)
            route.targetPort = svc?.port ?? (svc || !d.services.length ? implicitPort : null)
            route.network = network
            route.reattach = reattach
            route.warnings.push(...netWarn)
            if (route.targetPort === null && !svc?.urls.length && r.kind !== 'udp') route.warnings.push('Port de destination indéterminé (plusieurs ports exposés, aucun port déclaré)')
          }
          if (!r.rule && r.kind === 'http') {
            route.rule = dp.defaultRule ?? 'Host(`{{ normalize .Name }}`)'
            route.warnings.push('Route générée par la règle par défaut du fournisseur Docker')
          }
          if (c.state !== 'running' && route.container) route.warnings.push(`Conteneur ${c.state === 'exited' ? 'arrêté' : c.state}`)
          route.convertible = r.kind === 'http' && !!route.container && !!stackOf(c) && route.targetPort !== null && parseRule(r.rule).simple
          routes.push(route)
        }
      }
    }

    // Fournisseur fichier.
    for (const d of p.dynamic) {
      for (const r of d.routers) {
        const route = routeFrom(st, r, 'file')
        route.proxyId = p.containerId
        const svc = d.services.find(s => s.name === r.service?.replace(/@file$/, ''))
        const url = svc?.urls[0] ?? null
        route.targetUrl = url
        const up = url ? parseUpstream(url) : null
        const target = up ? containerByHost(containers, up.host, traefikNets) : null
        if (target) {
          route.container = ref(target)
          route.targetPort = up!.port
          route.network = target.networks.find(n => traefikNets.has(n)) ?? null
          if (!route.network) route.warnings.push('Aucun réseau commun avec Traefik')
        }
        routes.push(route)
      }
    }
  }

  // --- Autres proxies : sites lus dans leur configuration (nginx : présentés comme Traefik) ---
  for (const p of probes.filter(x => x.kind !== 'traefik')) {
    const proxy = byId.get(p.containerId)!
    const nets = new Set(proxy.networks.filter(n => !SYSTEM_NETWORKS.has(n)))
    const nginx = NGINX_KINDS.includes(p.kind)
    const managed = p.managed ?? null
    const redirectHosts = new Set(p.sites.filter(s => s.redirect).flatMap(s => s.hosts))
    // Réseau à rejoindre par une destination injoignable : celui du proxy déclaré, sinon son unique réseau.
    const joinable = managed?.network && nets.has(managed.network) ? managed.network : nets.size === 1 ? [...nets][0]! : null
    const routeWarnings = (target: TopoContainer | null, network: string | null, outside: string | null) => {
      const w: string[] = []
      if (!nginx || !managed) w.push(`Géré par ${p.kind}, hors plateforme`)
      else if (outside) w.push(outside)
      if (nginx && target && !network) w.push(`Aucun réseau commun avec ${p.kind} : la route ne peut pas fonctionner`)
      if (target && target.state !== 'running') w.push(`Conteneur ${target.state === 'exited' ? 'arrêté' : target.state}`)
      return w
    }
    for (const s of p.sites) {
      const up = s.upstream ? parseUpstream(s.upstream) : null
      const target = up ? containerByHost(containers, up.host, nets, aliases) : null
      const network = target?.networks.find(n => nets.has(n)) ?? null
      const platformFile = !!s.file && PLATFORM_FILE_RE.test(s.file)
      const redirectOnly = !!s.redirect
      routes.push({
        router: `${s.site}${s.pathPrefix ?? ''}${redirectOnly ? ' → https' : ''} (${proxy.name})`,
        proxyId: proxy.id,
        provider: p.kind === 'caddy' ? 'caddyfile' : 'nginx',
        kind: 'http',
        rule: s.site,
        hosts: s.hosts,
        pathPrefix: s.pathPrefix,
        entrypoints: nginx ? (s.listens ?? []).map(x => `:${x}`) : [],
        tls: s.tls,
        certResolver: null,
        tlsOptions: null,
        passthrough: false,
        redirectsToHttps: nginx && (redirectOnly || (s.tls && s.hosts.some(h => redirectHosts.has(h)))),
        middlewares: [],
        service: null,
        container: target ? ref(target) : null,
        targetPort: up?.port ?? null,
        targetUrl: s.upstream,
        network,
        convertible: nginx && !!managed && !platformFile && !redirectOnly && !!target && !!stackOf(target) && up?.port != null && s.hosts.length > 0 && s.hosts.every(h => SIMPLE_HOST_RE.test(h)),
        reattach: nginx && target && !network && joinable && !redirectOnly ? { network: joinable, reason: `Aucun réseau commun avec ${proxy.name}` } : null,
        warnings: redirectOnly ? [] : routeWarnings(target, network, platformFile ? null : `Site défini hors plateforme${s.file ? ` (${s.file})` : ''}`),
      })
    }
    // nginx-proxy : un site par conteneur portant VIRTUAL_HOST.
    if (p.virtualHosts) {
      const https = proxy.ports.some(x => x.privatePort === 443 && x.type === 'tcp')
      for (const v of p.virtualHosts) {
        const c = byId.get(v.containerId)
        if (!c) continue
        const network = c.networks.find(n => nets.has(n)) ?? null
        const tls = https && v.httpsMethod !== 'nohttps'
        const tcp = [...new Set(c.ports.filter(x => x.type === 'tcp').map(x => x.privatePort))]
        const port = v.port ?? (tcp.length === 1 ? tcp[0]! : tcp.includes(80) ? 80 : null)
        const platform = c.labels['platform.managed'] === 'true'
        routes.push({
          router: `${v.hosts[0] ?? c.name}${v.path ?? ''} (${proxy.name})`,
          proxyId: proxy.id,
          provider: 'nginx',
          kind: 'http',
          rule: `VIRTUAL_HOST=${v.hosts.join(',')}`,
          hosts: v.hosts,
          pathPrefix: v.path,
          entrypoints: [tls ? ':443' : ':80'],
          tls,
          certResolver: null,
          tlsOptions: null,
          passthrough: false,
          redirectsToHttps: tls && v.httpsMethod !== 'noredirect',
          middlewares: [],
          service: null,
          container: ref(c),
          targetPort: port,
          targetUrl: null,
          network,
          convertible: !!managed && !platform && !!stackOf(c) && port !== null && v.hosts.length > 0 && v.hosts.every(h => SIMPLE_HOST_RE.test(h)),
          reattach: !network && joinable ? { network: joinable, reason: `Aucun réseau commun avec ${proxy.name}` } : null,
          warnings: routeWarnings(c, network, platform ? null : 'Défini hors plateforme (VIRTUAL_HOST du conteneur)'),
        })
      }
    }
    if (p.kind === 'caddy-docker-proxy') {
      for (const c of containers) {
        for (const r of caddyLabelRoutes(c.labels)) {
          routes.push({
            router: `caddy (${c.name})`, proxyId: proxy.id, provider: 'caddy-labels', kind: 'http', rule: null, hosts: r.hosts, pathPrefix: null, entrypoints: [], tls: true,
            certResolver: null, tlsOptions: null, passthrough: false, redirectsToHttps: false, middlewares: [], service: null,
            container: ref(c), targetPort: r.port, targetUrl: null, network: c.networks.find(n => nets.has(n)) ?? null, convertible: false, warnings: ['Géré par caddy-docker-proxy, hors plateforme'],
          })
        }
      }
    }
    if (p.kind === 'nginx-proxy' && !p.virtualHosts) warnings.push(`${proxy.name} (nginx-proxy) : les domaines sont portés par la variable VIRTUAL_HOST des applications, dont les valeurs ne sont pas lues`)
  }

  // Doublons : même hôte et même chemin servis par deux destinations différentes.
  const seen = new Map<string, ProxyRoute>()
  for (const r of routes) {
    if (r.redirectsToHttps && !r.tls) continue
    for (const h of r.hosts) {
      const key = `${h}|${r.pathPrefix ?? ''}`
      const prev = seen.get(key)
      const dest = (x: ProxyRoute) => `${x.router} → ${x.container ? `${x.container.stack ?? x.container.name}/${x.container.service ?? x.container.name}` : x.targetUrl ?? '?'}`
      if (prev && prev.container?.id !== r.container?.id) {
        warnings.push(prev.router === r.router && r.provider === 'docker'
          ? `Routeur « ${r.router} » déclaré par plusieurs conteneurs (${dest(prev)}, ${dest(r)}) : Traefik le désactive faute de configuration unique`
          : `${h}${r.pathPrefix ?? ''} est routé deux fois (${dest(prev)}, ${dest(r)})`)
      }
      else seen.set(key, r)
    }
  }
  if (!proxies.length) warnings.push('Aucun reverse proxy détecté sur cet endpoint')

  routes.sort((a, b) => (a.hosts[0] ?? '~').localeCompare(b.hosts[0] ?? '~') || a.router.localeCompare(b.router))
  return { endpointId, scannedAt: new Date().toISOString(), proxies, routes, middlewares, warnings }
}
