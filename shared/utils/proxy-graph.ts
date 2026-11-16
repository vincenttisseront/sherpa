/**
 * Vue flux des reverse proxies : URL publique → port de l'hôte → reverse proxy
 * → stack. Une URL par domaine (et chemin) servi ; ses ports sont ceux des points
 * d'entrée qui la servent ; une stack regroupe les services qu'elle expose. Les
 * ports publiés hors proxy mènent directement à leur stack. Fonction pure.
 */
import type { DetectedProxy, ProxyRoute } from '../schemas/proxy'
import type { MapContainer, MapHostCertificate, ProxyMapDto } from '../schemas/proxy-map'

export type CertState = MapHostCertificate['state'] | 'none'

export interface GraphUrl { id: string, proxyId: string, host: string, path: string | null, url: string, tls: boolean, cert: CertState, certs: MapHostCertificate[], indexes: number[], warnings: string[], redirect: boolean, stacks: string[] }
export interface GraphPort { id: string, host: string, containerPort: number, protocol: string, proxyId: string | null, entrypoint: string | null, stackId: string | null }
export interface GraphEntrypoint { name: string, port: number | null, protocol: string, tls: boolean, redirectTo: string | null, certResolver: string | null }
export interface GraphProxy { id: string, proxy: DetectedProxy, entrypoints: GraphEntrypoint[], routes: number }
export interface GraphStack { id: string, name: string, kind: 'routed' | 'direct' | 'unrouted', managed: boolean, project: MapContainer['project'], services: { service: string, ports: number[], running: boolean }[], containers: MapContainer[] }
export interface GraphEdge { from: string, to: string, kind: 'url' | 'port' | 'stack' | 'direct' | 'network', label: string | null, warn: boolean }

/** Élément choisi dans le diagramme (détail). */
export type MapSelection = { kind: 'proxy', id: string } | { kind: 'routes', indexes: number[] } | { kind: 'containers', ids: string[] }

export interface ProxyGraph {
  urls: GraphUrl[]
  ports: GraphPort[]
  proxies: GraphProxy[]
  stacks: GraphStack[]
  edges: GraphEdge[]
}

export interface GraphOptions {
  proxyId?: string | null
  query?: string
  /** Ports publiés directement par des stacks (hors proxy). */
  showDirect?: boolean
  /** Stacks attachées à un réseau de proxy sans route. */
  showUnrouted?: boolean
}

const CERT_RANK: Record<CertState, number> = { expired: 0, error: 1, expiring: 2, pending: 3, static: 4, valid: 5, none: 6 }

export function worstCert(certs: readonly MapHostCertificate[], tls: boolean): CertState {
  if (!tls) return 'none'
  if (!certs.length) return 'static'
  return certs.map(c => c.state).sort((a, b) => CERT_RANK[a] - CERT_RANK[b])[0]!
}

const uniq = <T>(a: T[]) => [...new Set(a)]
const stackKey = (c: { stack: string | null, name: string }) => c.stack ?? c.name
/** Port public d'une adresse « ip:port » ; 80/443 omis dans l'URL. */
const publicPort = (binding: string) => Number(binding.split(':').pop())

export function buildProxyGraph(map: ProxyMapDto, opts: GraphOptions = {}): ProxyGraph {
  const q = opts.query?.trim().toLowerCase() ?? ''
  const proxies = map.topology.proxies.filter(p => !opts.proxyId || p.container.id === opts.proxyId)
  const proxyIds = new Set(proxies.map(p => p.container.id))
  const byContainer = new Map(map.containers.map(c => [c.id, c]))
  const edges: GraphEdge[] = []
  const keys = new Set<string>()
  const addEdge = (e: GraphEdge) => {
    const k = `${e.from}>${e.to}`
    if (keys.has(k)) return
    keys.add(k)
    edges.push(e)
  }

  const routeText = (r: ProxyRoute) => `${r.hosts.join(' ')} ${r.pathPrefix ?? ''} ${r.router} ${r.container?.stack ?? ''} ${r.container?.service ?? ''}`.toLowerCase()
  const routes = map.topology.routes
    .map((route, index) => ({ route, index }))
    .filter(({ route }) => proxyIds.has(route.proxyId) && (!q || routeText(route).includes(q)))

  // Ports de l'hôte des proxies, rattachés à leur point d'entrée.
  const ports: GraphPort[] = []
  const gProxies: GraphProxy[] = proxies.map((p) => {
    // nginx : ses écoutes (« :443 ») tiennent lieu de points d'entrée.
    const declared = p.traefik?.entrypoints ?? (p.nginx?.listens ?? []).map(l => ({ name: `:${l.port}`, port: l.port as number | null, protocol: 'tcp' as const, tls: l.tls, redirectTo: l.redirectTo, certResolver: null as string | null }))
    const eps = declared.map(e => ({ name: e.name, port: e.port, protocol: e.protocol, tls: e.tls, redirectTo: e.redirectTo, certResolver: e.certResolver }))
    for (const h of p.hostPorts) {
      const ep = declared.find(e => e.port === h.container && e.protocol === h.protocol)
      const id = `port:${p.container.id}:${h.host}/${h.protocol}`
      ports.push({ id, host: h.host, containerPort: h.container, protocol: h.protocol, proxyId: p.container.id, entrypoint: ep?.name ?? null, stackId: null })
      addEdge({ from: id, to: `proxy:${p.container.id}`, kind: 'port', label: null, warn: false })
    }
    return { id: `proxy:${p.container.id}`, proxy: p, entrypoints: eps, routes: routes.filter(r => r.route.proxyId === p.container.id).length }
  })

  // URL publiques : une par proxy, domaine et chemin ; servies par les ports de leurs points d'entrée.
  const urls = new Map<string, GraphUrl>()
  for (const { route, index } of routes) {
    const gp = gProxies.find(p => p.proxy.container.id === route.proxyId)!
    const own = ports.filter(p => p.proxyId === route.proxyId)
    let servedPorts: GraphPort[]
    let scheme = route.tls ? 'https' : 'http'
    let hosts = route.hosts.length ? route.hosts : [route.rule ?? route.router]
    if (gp.proxy.traefik || (gp.proxy.nginx && route.entrypoints.length)) {
      const eps = route.entrypoints.length ? route.entrypoints : gp.entrypoints.map(e => e.name)
      servedPorts = own.filter(p => p.entrypoint && eps.includes(p.entrypoint))
    }
    else {
      // Autres proxies : adresse du site (« :8444 », « http://:8081 », « exemple.fr ») → port du conteneur servi.
      // Variables Caddy {$NOM:défaut} : leur valeur par défaut.
      const address = (route.rule ?? '').replace(/\{\$[A-Za-z_][A-Za-z0-9_]*:([^}]*)\}/g, '$1')
      const site = /^(?:(https?):\/\/)?([^:/\s]*)(?::(\d+))?/.exec(address) ?? []
      const sitePort = site[3] ? Number(site[3]) : site[1] === 'http' ? 80 : 443
      scheme = site[1] ?? (sitePort === 80 ? 'http' : route.tls ? 'https' : 'http')
      hosts = route.hosts.length ? route.hosts.map(h => h.replace(/\{\$[A-Za-z_][A-Za-z0-9_]*:([^}]*)\}/g, '$1')) : [site[2] || '*']
      servedPorts = own.filter(p => p.containerPort === sitePort)
    }
    // Port public : celui du point d'entrée qui sert réellement la route (TLS pour une route HTTPS).
    const main = servedPorts.find(p => !(gp.proxy.traefik || gp.proxy.nginx) || gp.entrypoints.find(e => e.name === p.entrypoint)?.redirectTo == null) ?? servedPorts[0]
    const port = main ? publicPort(main.host) : null
    const portPart = port && !((scheme === 'https' && port === 443) || (scheme === 'http' && port === 80)) ? `:${port}` : ''
    for (const host of hosts) {
      const key = `${route.proxyId}|${host}|${route.pathPrefix ?? ''}`
      let u = urls.get(key)
      const url = `${scheme}://${host}${portPart}${route.pathPrefix ?? ''}`
      if (!u) {
        u = { id: `url:${urls.size}`, proxyId: route.proxyId, host, path: route.pathPrefix, url, tls: false, cert: 'none', certs: [], indexes: [], warnings: [], redirect: true, stacks: [] }
        urls.set(key, u)
      }
      // L'adresse affichée est celle de la route qui sert (HTTPS de préférence à sa redirection HTTP).
      if (!(route.redirectsToHttps && !route.tls) && (route.tls || u.redirect)) u.url = url
      u.indexes.push(index)
      u.tls ||= route.tls
      // Une URL n'est « redirection seule » que si toutes ses routes ne font que rediriger.
      u.redirect &&= route.redirectsToHttps && !route.tls
      u.warnings = uniq([...u.warnings, ...route.warnings])
      for (const p of servedPorts) addEdge({ from: u.id, to: p.id, kind: 'url', label: null, warn: false })
      if (!servedPorts.length) addEdge({ from: u.id, to: gp.id, kind: 'url', label: null, warn: false })
    }
  }
  for (const u of urls.values()) {
    u.certs = map.certificates.filter(c => c.proxyId === u.proxyId && c.host === u.host)
    u.cert = worstCert(u.certs, u.tls)
  }

  // Stacks : destinations des routes (services et ports), regroupées par projet Compose.
  const stacks = new Map<string, GraphStack>()
  const stackOf = (c: MapContainer, kind: GraphStack['kind']) => {
    const id = `stack:${stackKey(c)}`
    let s = stacks.get(id)
    if (!s) {
      s = { id, name: stackKey(c), kind, managed: c.managed, project: c.project, services: [], containers: [] }
      stacks.set(id, s)
    }
    if (!s.containers.some(x => x.id === c.id)) s.containers.push(c)
    return s
  }
  const addService = (s: GraphStack, c: MapContainer, port: number | null) => {
    const name = c.service ?? c.name
    let svc = s.services.find(x => x.service === name)
    if (!svc) {
      svc = { service: name, ports: [], running: c.running }
      s.services.push(svc)
    }
    if (port && !svc.ports.includes(port)) svc.ports.push(port)
  }
  for (const { route } of routes) {
    const c = route.container ? byContainer.get(route.container.id) : undefined
    if (!c) continue
    const s = stackOf(c, 'routed')
    s.kind = 'routed'
    addService(s, c, route.targetPort)
    addEdge({ from: `proxy:${route.proxyId}`, to: s.id, kind: 'stack', label: null, warn: route.warnings.length > 0 || !c.running })
    for (const u of urls.values()) if (u.indexes.some(i => map.topology.routes[i]?.container?.id === c.id) && !u.stacks.includes(s.id)) u.stacks.push(s.id)
  }

  const matches = (c: MapContainer) => !q || `${c.name} ${c.stack ?? ''} ${c.service ?? ''}`.toLowerCase().includes(q)
  // Ports publiés hors proxy : port de l'hôte → stack, directement.
  if (opts.showDirect !== false) {
    for (const c of map.containers.filter(x => x.hostPorts.length && matches(x))) {
      const s = stackOf(c, stacks.get(`stack:${stackKey(c)}`)?.kind ?? 'direct')
      addService(s, c, null)
      for (const h of c.hostPorts) {
        const id = `port:${c.id}:${h.host}/${h.protocol}`
        ports.push({ id, host: h.host, containerPort: h.container, protocol: h.protocol, proxyId: null, entrypoint: null, stackId: s.id })
        addEdge({ from: id, to: s.id, kind: 'direct', label: `${c.service ?? c.name}:${h.container}`, warn: !h.host.startsWith('127.') })
      }
    }
  }
  // Stacks attachées à un réseau de proxy sans route.
  if (opts.showUnrouted !== false && !q) {
    for (const c of map.containers) {
      if (stacks.has(`stack:${stackKey(c)}`)) continue
      const nets = c.proxyNetworks.filter(n => proxies.some(p => p.networks.includes(n)))
      if (!nets.length) continue
      const s = stackOf(c, 'unrouted')
      addService(s, c, null)
      for (const p of proxies.filter(x => x.networks.some(n => nets.includes(n)))) addEdge({ from: `proxy:${p.container.id}`, to: s.id, kind: 'network', label: null, warn: false })
    }
  }
  for (const s of stacks.values()) s.services.sort((a, b) => a.service.localeCompare(b.service))
  // Libellé proxy → stack : services et ports servis.
  for (const e of edges.filter(x => x.kind === 'stack')) {
    const s = stacks.get(e.to)!
    e.label = s.services.filter(x => x.ports.length).map(x => `${x.service}:${x.ports.join(',')}`).slice(0, 2).join(' ') || null
  }

  // Ordre : URL par domaine ; ports par proxy puis numéro ; stacks dans l'ordre des flux qui y mènent.
  const urlList = [...urls.values()].sort((a, b) => Number(a.redirect) - Number(b.redirect) || a.host.localeCompare(b.host))
  const portList = ports.sort((a, b) => Number(!a.proxyId) - Number(!b.proxyId) || (a.proxyId ?? '').localeCompare(b.proxyId ?? '') || publicPort(a.host) - publicPort(b.host))
  const rank = { routed: 0, direct: 1, unrouted: 2 } as const
  const stackList = [...stacks.values()].sort((a, b) => rank[a.kind] - rank[b.kind] || Number(b.managed) - Number(a.managed) || a.name.localeCompare(b.name))
  return { urls: urlList, ports: portList, proxies: gProxies, stacks: stackList, edges }
}

/**
 * Flux d'un nœud, mis en évidence au survol : une URL éclaire ses ports, son proxy et
 * seulement ses stacks ; une stack, les URL qui y mènent ; un port ou un proxy, tout ce qui le traverse.
 */
export function flowOf(g: ProxyGraph, id: string): Set<string> {
  const lit = new Set<string>([id])
  const viaUrl = (u: GraphUrl) => {
    lit.add(u.id)
    lit.add(`proxy:${u.proxyId}`)
    for (const e of g.edges) if (e.from === u.id) lit.add(e.to)
    for (const st of u.stacks) lit.add(st)
  }
  const url = g.urls.find(u => u.id === id)
  if (url) {
    viaUrl(url)
    return lit
  }
  const stack = g.stacks.find(s => s.id === id)
  if (stack) {
    for (const u of g.urls.filter(x => x.stacks.includes(id))) viaUrl(u)
    for (const e of g.edges) if (e.to === id) lit.add(e.from)
    for (const u of g.urls) if (!u.stacks.includes(id)) lit.delete(u.id)
    return lit
  }
  return connectedNodes(g.edges, id)
}

/** Nœuds reliés (en amont et en aval) à un nœud : chemin complet mis en évidence au survol. */
export function connectedNodes(edges: readonly GraphEdge[], start: string): Set<string> {
  const seen = new Set<string>([start])
  for (const dir of ['down', 'up'] as const) {
    const queue = [start]
    while (queue.length) {
      const n = queue.shift()!
      for (const e of edges) {
        const [a, b] = dir === 'down' ? [e.from, e.to] : [e.to, e.from]
        if (a === n && !seen.has(b)) {
          seen.add(b)
          queue.push(b)
        }
      }
    }
  }
  return seen
}
