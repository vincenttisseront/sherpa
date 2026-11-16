/**
 * Reverse proxies autres que Traefik : reconnaissance par l'image et lecture
 * indicative de leur configuration (sites, domaines, destinations). La
 * plateforme ne les pilote pas ; ils sont signalés pour la reprise de l'existant.
 */
import type { ProxyKind } from '../../../shared/schemas/proxy'

const KINDS: { kind: ProxyKind, re: RegExp, dedicated: boolean }[] = [
  { kind: 'traefik', re: /(?:^|\/)traefik(?::|@|$)/, dedicated: true },
  { kind: 'caddy-docker-proxy', re: /lucaslorentz\/caddy-docker-proxy/, dedicated: true },
  { kind: 'nginx-proxy-manager', re: /jc21\/nginx-proxy-manager/, dedicated: true },
  { kind: 'nginx-proxy', re: /(?:nginxproxy|jwilder)\/nginx-proxy/, dedicated: true },
  { kind: 'swag', re: /linuxserver\/swag/, dedicated: true },
  { kind: 'haproxy', re: /(?:^|\/)haproxy(?:[:@-]|$)/, dedicated: true },
  { kind: 'envoy', re: /envoyproxy\/envoy/, dedicated: true },
  { kind: 'caddy', re: /(?:^|\/)caddy(?::|@|$)/, dedicated: false },
  { kind: 'nginx', re: /(?:^|\/)nginx(?:-unprivileged)?(?::|@|$)/, dedicated: false },
  { kind: 'httpd', re: /(?:^|\/)httpd(?::|@|$)/, dedicated: false },
]

/**
 * Type de proxy d'un conteneur. Un serveur web générique (nginx, Caddy,
 * Apache) n'est retenu que s'il publie 80 ou 443 sur l'hôte : sinon c'est
 * le plus souvent le serveur d'une application.
 */
export function proxyKindOf(image: string, publishedPorts: readonly number[]): ProxyKind | null {
  const name = image.toLowerCase().replace(/^docker\.io\//, '').replace(/^library\//, '')
  const k = KINDS.find(x => x.re.test(name))
  if (!k) return null
  if (!k.dedicated && !publishedPorts.some(p => p === 80 || p === 443)) return null
  return k.kind
}

/** Fichiers de configuration lus par type (fichier ou répertoire). */
export const CONFIG_PATHS: Partial<Record<ProxyKind, string[]>> = {
  'caddy': ['/etc/caddy/Caddyfile'],
  'nginx': ['/etc/nginx/nginx.conf', '/etc/nginx/conf.d', '/etc/nginx/sites-enabled'],
  'nginx-proxy-manager': ['/data/nginx/proxy_host'],
  'swag': ['/config/nginx/nginx.conf', '/config/nginx/site-confs', '/config/nginx/proxy-confs'],
  'httpd': [],
}

export interface SiteRoute {
  site: string
  hosts: string[]
  pathPrefix: string | null
  tls: boolean
  upstream: string | null
  /** nginx : ports d'écoute du bloc server. */
  listens?: number[]
  /** nginx : bloc qui ne fait que rediriger vers HTTPS (return 301 https://…). */
  redirect?: boolean
  /** Fichier de configuration d'origine. */
  file?: string
}

/** Familles nginx : sites lus dans la configuration, présentés comme Traefik. */
export const NGINX_KINDS: readonly ProxyKind[] = ['nginx', 'nginx-proxy', 'swag']

const stripComments = (text: string) => text.split('\n').map(l => l.replace(/(^|\s)#.*$/, '')).join('\n')

/** Port d'une directive listen (« 443 ssl », « [::]:80 », « 0.0.0.0:8080 ») ; null pour un socket unix. */
function listenPort(arg: string | undefined): number | null {
  if (!arg || arg.startsWith('unix:')) return null
  const m = /(?:^|:)(\d+)$/.exec(arg)
  return m ? Number(m[1]) : 80
}

const isHttpsRedirect = (d: string[]) => d[0] === 'return' && /^30[1278]$/.test(d[1] ?? '') && /^https:\/\//.test(d[2] ?? '')

/**
 * Blocs server { } de nginx : server_name, listen (ports, ssl), redirection vers HTTPS,
 * location … proxy_pass (variables « set » et blocs upstream résolus).
 */
export function parseNginx(text: string, file?: string): SiteRoute[] {
  const tokens = stripComments(text).match(/[{};]|"[^"]*"|'[^']*'|[^\s{};]+/g) ?? []
  const routes: SiteRoute[] = []
  interface Block { name: string, args: string[], directives: string[][], children: Block[] }
  const root: Block = { name: '', args: [], directives: [], children: [] }
  const stack: Block[] = [root]
  let cur: string[] = []
  for (const t of tokens) {
    if (t === '{') {
      const b: Block = { name: cur[0] ?? '', args: cur.slice(1), directives: [], children: [] }
      stack.at(-1)!.children.push(b)
      stack.push(b)
      cur = []
    }
    else if (t === '}') {
      if (stack.length > 1) stack.pop()
      cur = []
    }
    else if (t === ';') {
      if (cur.length) stack.at(-1)!.directives.push(cur)
      cur = []
    }
    else {
      cur.push(t.replace(/^["']|["']$/g, ''))
    }
  }
  const servers: Block[] = []
  const upstreams = new Map<string, string>()
  const walk = (b: Block) => {
    for (const c of b.children) {
      if (c.name === 'server') servers.push(c)
      else if (c.name === 'upstream' && c.args[0]) {
        const first = c.directives.find(d => d[0] === 'server')?.[1]
        if (first) upstreams.set(c.args[0], first)
      }
      else walk(c)
    }
  }
  walk(root)
  const vars = (b: Block) => new Map(b.directives.filter(d => d[0] === 'set' && d[1]?.startsWith('$') && d[2]).map(d => [d[1]!.slice(1), d[2]!] as const))
  // proxy_pass $var → valeur du « set » ; http://nom_upstream → premier serveur du bloc upstream.
  const resolve = (raw: string, scopes: Map<string, string>[]): string => {
    let v = raw
    const m = /^\$([A-Za-z_][A-Za-z0-9_]*)(.*)$/.exec(v)
    if (m) {
      const val = scopes.map(x => x.get(m[1]!)).find(x => x !== undefined)
      if (val !== undefined) v = `${val}${m[2]}`
    }
    const u = /^(https?:\/\/)([^/:$]+)(.*)$/.exec(v)
    const up = u ? upstreams.get(u[2]!) : undefined
    return up && u ? `${u[1]}${up}${u[3]}` : v
  }
  for (const s of servers) {
    const names = s.directives.filter(d => d[0] === 'server_name').flatMap(d => d.slice(1)).filter(n => n && n !== '_' && n !== 'localhost')
    const listenDirs = s.directives.filter(d => d[0] === 'listen')
    const listens = [...new Set(listenDirs.map(d => listenPort(d[1])).filter((x): x is number => x !== null))]
    if (!listenDirs.length) listens.push(80)
    const tls = listenDirs.some(d => d.slice(1).includes('ssl') || /(?:^|:)443$/.test(d[1] ?? '')) || s.directives.some(d => d[0] === 'ssl_certificate')
    const serverVars = vars(s)
    const locs = s.children.filter(c => c.name === 'location')
    const site = names[0] ?? (listenDirs[0] ? `listen ${listenDirs[0].slice(1).join(' ')}` : 'server')
    const base = { site, hosts: names, tls, listens, ...(file ? { file } : {}) }
    const out: SiteRoute[] = []
    const direct = s.directives.find(d => d[0] === 'proxy_pass')?.[1]
    if (direct) out.push({ ...base, pathPrefix: null, upstream: resolve(direct, [serverVars]) })
    for (const l of locs) {
      const pass = l.directives.find(d => d[0] === 'proxy_pass')?.[1]
      if (!pass) continue
      const path = l.args.filter(a => !/^[=~^]+\*?$/.test(a)).at(-1) ?? '/'
      out.push({ ...base, pathPrefix: path === '/' || !path.startsWith('/') ? null : path, upstream: resolve(pass, [vars(l), serverVars]) })
    }
    // Bloc de redirection : « return 301 https://… » au niveau server ou dans « location / ».
    const redirect = s.directives.some(isHttpsRedirect) || locs.some(l => (l.args.at(-1) ?? '') === '/' && l.directives.some(isHttpsRedirect))
    if (redirect && !out.length) out.push({ ...base, tls: false, pathPrefix: null, upstream: null, redirect: true })
    routes.push(...out)
  }
  return routes
}

/** Caddyfile : blocs de site de premier niveau, adresses et reverse_proxy. */
export function parseCaddyfile(text: string): SiteRoute[] {
  const lines = stripComments(text).split('\n')
  const routes: SiteRoute[] = []
  let depth = 0
  let site: { addresses: string[], upstreams: string[], tlsOff: boolean } | null = null
  const flush = () => {
    if (!site) return
    // Variables Caddy {$NOM:défaut} : seule la valeur par défaut est connue (l'environnement n'est pas lu).
    const hosts = site.addresses.map(a => a.replace(/\{\$[A-Za-z0-9_]+(?::([^}]*))?\}/g, (_m, d: string | undefined) => d ?? '').replace(/^https?:\/\//, '').replace(/:\d+$/, '').replace(/\/.*$/, '')).filter(h => h && !h.startsWith(':') && h !== 'localhost')
    const tls = !site.tlsOff && site.addresses.some(a => !a.startsWith('http://') && !a.startsWith(':') && !/:80$/.test(a))
    const name = site.addresses.join(', ')
    if (!site.upstreams.length) routes.push({ site: name, hosts, pathPrefix: null, tls, upstream: null })
    for (const u of site.upstreams) routes.push({ site: name, hosts, pathPrefix: null, tls, upstream: u })
    site = null
  }
  for (const raw of lines) {
    const line = raw.trim()
    if (!line) continue
    const opens = (line.match(/\{/g) ?? []).length
    const closes = (line.match(/\}/g) ?? []).length
    if (depth === 0 && line.endsWith('{')) {
      const head = line.slice(0, -1).trim()
      // Bloc global `{` ou extrait réutilisable `(nom)` : pas un site.
      if (head && !head.startsWith('(')) site = { addresses: head.split(/[\s,]+/).filter(Boolean), upstreams: [], tlsOff: false }
    }
    else if (site) {
      const words = line.replace(/[{}]/g, ' ').trim().split(/\s+/)
      if (words[0] === 'reverse_proxy') site.upstreams.push(...words.slice(1).filter(w => !w.startsWith('@') && !w.startsWith('/') && w !== '*'))
      if (words[0] === 'tls' && words[1] === 'off') site.tlsOff = true
    }
    depth += opens - closes
    if (depth <= 0) {
      depth = 0
      if (closes) flush()
    }
  }
  flush()
  return routes
}

/** Labels caddy-docker-proxy : `caddy=domaine`, `caddy.reverse_proxy={{upstreams 80}}`. */
export function caddyLabelRoutes(labels: Record<string, string>): { hosts: string[], port: number | null }[] {
  const out: { hosts: string[], port: number | null }[] = []
  const prefixes = new Set(Object.keys(labels).map(k => /^(caddy(?:_\d+)?)(?:\.|$)/.exec(k)?.[1]).filter((p): p is string => !!p))
  for (const p of prefixes) {
    const addr = labels[p]
    if (!addr) continue
    const up = labels[`${p}.reverse_proxy`] ?? ''
    const port = /upstreams\s+(?:https?\s+)?(\d+)/.exec(up)?.[1]
    out.push({ hosts: addr.split(/[\s,]+/).map(a => a.replace(/^https?:\/\//, '')).filter(Boolean), port: port ? Number(port) : null })
  }
  return out
}

/** `http://app:3000/x` ou `app:3000` → hôte et port. */
export function parseUpstream(u: string): { host: string, port: number | null } | null {
  const m = /^(?:[a-z]+:\/\/)?\[?([A-Za-z0-9_.-]+)\]?(?::(\d+))?/.exec(u.trim())
  if (!m || m[1]!.startsWith('$')) return null
  return { host: m[1]!.toLowerCase(), port: m[2] ? Number(m[2]) : null }
}
