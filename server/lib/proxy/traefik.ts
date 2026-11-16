/**
 * Interprétation de la configuration Traefik : statique (points d'entrée,
 * résolveurs de certificats, fournisseurs) et dynamique (routeurs, services,
 * middlewares, options TLS) issue des labels Docker ou du fournisseur fichier.
 * Liste blanche stricte : seuls des noms, adresses, booléens et chemins sont
 * extraits ; e-mails ACME, identifiants DNS, utilisateurs et clés sont ignorés.
 */
import type { TlsOptionInfo, TraefikCertResolver, TraefikEntrypoint, TraefikStatic } from '../../../shared/schemas/proxy'
import { type Flat, bool, children, has, list, str } from './flat'

/** Emplacements lus par Traefik quand aucun --configFile n'est donné. */
export const DEFAULT_CONFIG_PATHS = ['/etc/traefik/traefik.yml', '/etc/traefik/traefik.yaml', '/etc/traefik/traefik.toml']

/** Arguments effectifs de Traefik à partir de Entrypoint + Cmd du conteneur. */
export function traefikArgs(entrypoint: readonly string[], cmd: readonly string[]): string[] {
  const all = [...entrypoint, ...cmd]
  return all.filter(a => a.startsWith('-'))
}

function parseAddress(address: string | null): { port: number | null, protocol: 'tcp' | 'udp' } {
  if (!address) return { port: null, protocol: 'tcp' }
  const m = /:(\d{1,5})(?:\/(tcp|udp))?$/i.exec(address.trim())
  return { port: m ? Number(m[1]) : null, protocol: m?.[2]?.toLowerCase() === 'udp' ? 'udp' : 'tcp' }
}

export function interpretStatic(flat: Flat, source: TraefikStatic['source'], configFile: string | null): TraefikStatic {
  const warnings: string[] = []
  let names = children(flat, 'entrypoints')
  if (!names.length) {
    // Sans point d'entrée déclaré, Traefik écoute sur :80 (« http »).
    names = ['http']
    flat.set('entrypoints.http.address', ':80')
    warnings.push('Aucun point d\'entrée déclaré : Traefik utilise « http » sur le port 80')
  }
  const entrypoints: TraefikEntrypoint[] = names.map((n) => {
    const p = `entrypoints.${n}`
    const address = str(flat.get(`${p}.address`))
    return {
      name: n,
      address,
      ...parseAddress(address),
      redirectTo: str(flat.get(`${p}.http.redirections.entrypoint.to`)),
      tls: has(flat, `${p}.http.tls`) && bool(flat.get(`${p}.http.tls`), true),
      certResolver: str(flat.get(`${p}.http.tls.certresolver`)),
      middlewares: list(flat.get(`${p}.http.middlewares`)),
      hostPorts: [],
    }
  })
  // « to: :443 » désigne le point d'entrée par son adresse.
  for (const e of entrypoints) {
    if (e.redirectTo?.startsWith(':')) {
      const port = Number(e.redirectTo.slice(1))
      e.redirectTo = entrypoints.find(x => x.port === port)?.name ?? e.redirectTo
    }
  }

  const certResolvers: TraefikCertResolver[] = children(flat, 'certificatesresolvers').map((n) => {
    const p = `certificatesresolvers.${n}.acme`
    const dns = str(flat.get(`${p}.dnschallenge.provider`))
    const http = has(flat, `${p}.httpchallenge`)
    const tls = has(flat, `${p}.tlschallenge`)
    return {
      name: n,
      challenge: dns ? 'dns' : http ? 'http' : tls ? 'tls' : null,
      dnsProvider: dns,
      httpEntrypoint: str(flat.get(`${p}.httpchallenge.entrypoint`)),
      staging: /staging/i.test(str(flat.get(`${p}.caserver`)) ?? ''),
      storage: str(flat.get(`${p}.storage`)),
    }
  })
  for (const r of certResolvers) {
    if (r.staging) warnings.push(`Le résolveur « ${r.name} » utilise l'autorité ACME de test (certificats non reconnus)`)
    if (!r.challenge) warnings.push(`Le résolveur « ${r.name} » n'a pas de challenge ACME configuré`)
  }
  for (const e of entrypoints) {
    if (e.certResolver && !certResolvers.some(r => r.name === e.certResolver)) warnings.push(`Point d'entrée « ${e.name} » : résolveur « ${e.certResolver} » inconnu`)
    if (e.redirectTo && !entrypoints.some(x => x.name === e.redirectTo)) warnings.push(`Point d'entrée « ${e.name} » : redirection vers « ${e.redirectTo} » inconnu`)
  }

  const providerNames = children(flat, 'providers')
  const docker = has(flat, 'providers.docker') && bool(flat.get('providers.docker'), true)
    ? {
        enabled: true,
        exposedByDefault: bool(flat.get('providers.docker.exposedbydefault'), true),
        network: str(flat.get('providers.docker.network')),
        defaultRule: str(flat.get('providers.docker.defaultrule')),
        constraints: str(flat.get('providers.docker.constraints')),
      }
    : null
  if (docker?.exposedByDefault) warnings.push('exposedByDefault est actif : tout conteneur visible par Traefik reçoit une route par défaut')
  const file = has(flat, 'providers.file')
    ? { filename: str(flat.get('providers.file.filename')), directory: str(flat.get('providers.file.directory')), watch: bool(flat.get('providers.file.watch')) }
    : null
  const api = { dashboard: has(flat, 'api') && bool(flat.get('api.dashboard'), true), insecure: bool(flat.get('api.insecure')) }
  if (api.insecure) warnings.push('API et tableau de bord Traefik exposés sans authentification (api.insecure)')

  return {
    source,
    configFile,
    entrypoints,
    certResolvers,
    providers: {
      docker,
      swarm: has(flat, 'providers.swarm') || bool(flat.get('providers.docker.swarmmode')),
      file,
      other: providerNames.filter(n => !['docker', 'swarm', 'file', 'providersthrottleduration'].includes(n)),
    },
    api,
    accessLog: has(flat, 'accesslog'),
    metrics: children(flat, 'metrics'),
    warnings,
  }
}

// ---------------------------------------------------------------------------
// Règles de routage
// ---------------------------------------------------------------------------

export interface ParsedRule { hosts: string[], pathPrefix: string | null, simple: boolean }

const MATCHER_RE = /(!?)\s*([A-Za-z]+)\s*\(([^)]*)\)/g
const ARG_RE = /[`"']([^`"']*)[`"']/g

export function parseRule(rule: string | null): ParsedRule {
  if (!rule) return { hosts: [], pathPrefix: null, simple: false }
  const hosts: string[] = []
  const paths: string[] = []
  let simple = true
  for (const m of rule.matchAll(MATCHER_RE)) {
    const args = [...m[3]!.matchAll(ARG_RE)].map(a => a[1]!)
    const name = m[2]!.toLowerCase()
    if (m[1]) simple = false
    if (name === 'host' || name === 'hostsni') hosts.push(...args.map(h => h.toLowerCase()))
    else if (name === 'pathprefix' || name === 'path') {
      paths.push(...args)
      if (name === 'path') simple = false
    }
    else simple = false
  }
  // Toute autre syntaxe (expressions régulières, en-têtes, méthodes) reste à convertir à la main.
  const rest = rule.replace(MATCHER_RE, '').replace(/[()\s]|&&|\|\|/g, '')
  if (rest) simple = false
  if (paths.length > 1) simple = false
  if (paths.length === 1 && !/&&/.test(rule)) simple = false
  if (hosts.length > 1 && /&&/.test(rule.replace(/PathPrefix\s*\([^)]*\)/i, ''))) simple = false
  if (!hosts.length || hosts.some(h => h === '*' || h.includes('{'))) simple = false
  return { hosts: [...new Set(hosts)], pathPrefix: paths[0] ?? null, simple }
}

// ---------------------------------------------------------------------------
// Configuration dynamique (labels Docker ou fournisseur fichier)
// ---------------------------------------------------------------------------

export interface DynRouter {
  name: string
  kind: 'http' | 'tcp' | 'udp'
  rule: string | null
  entrypoints: string[]
  tls: boolean
  certResolver: string | null
  tlsOptions: string | null
  passthrough: boolean
  middlewares: string[]
  service: string | null
}

export interface DynService { name: string, kind: 'http' | 'tcp' | 'udp', port: number | null, urls: string[] }

export interface Dynamic {
  routers: DynRouter[]
  services: DynService[]
  middlewares: { name: string, type: string }[]
  tlsOptions: TlsOptionInfo[]
  certificates: { files: number, defaultCertificate: boolean }
}

export function interpretDynamic(flat: Flat): Dynamic {
  const routers: DynRouter[] = []
  const services: DynService[] = []
  for (const kind of ['http', 'tcp', 'udp'] as const) {
    for (const n of children(flat, `${kind}.routers`)) {
      const p = `${kind}.routers.${n}`
      const tlsSet = has(flat, `${p}.tls`)
      routers.push({
        name: n,
        kind,
        rule: str(flat.get(`${p}.rule`)),
        entrypoints: list(flat.get(`${p}.entrypoints`)),
        tls: tlsSet && (flat.get(`${p}.tls`) === undefined || bool(flat.get(`${p}.tls`), true)),
        certResolver: str(flat.get(`${p}.tls.certresolver`)),
        tlsOptions: str(flat.get(`${p}.tls.options`)),
        passthrough: bool(flat.get(`${p}.tls.passthrough`)),
        middlewares: list(flat.get(`${p}.middlewares`)),
        service: str(flat.get(`${p}.service`)),
      })
    }
    for (const n of children(flat, `${kind}.services`)) {
      const p = `${kind}.services.${n}.loadbalancer`
      const port = Number(str(flat.get(`${p}.server.port`)))
      const urls = children(flat, `${p}.servers`).map(i => str(flat.get(`${p}.servers.${i}.url`)) ?? str(flat.get(`${p}.servers.${i}.address`))).filter((u): u is string => !!u)
      services.push({ name: n, kind, port: Number.isInteger(port) && port > 0 ? port : null, urls })
    }
  }
  const middlewares = children(flat, 'http.middlewares').map(n => ({ name: n, type: children(flat, `http.middlewares.${n}`)[0] ?? 'inconnu' }))
  const tlsOptions: TlsOptionInfo[] = children(flat, 'tls.options').map((n) => {
    const p = `tls.options.${n}`
    return {
      name: n,
      minVersion: str(flat.get(`${p}.minversion`)),
      maxVersion: str(flat.get(`${p}.maxversion`)),
      sniStrict: bool(flat.get(`${p}.snistrict`)),
      cipherSuites: list(flat.get(`${p}.ciphersuites`)).length,
      clientAuth: str(flat.get(`${p}.clientauth.clientauthtype`)),
    }
  })
  return {
    routers,
    services,
    middlewares,
    tlsOptions,
    certificates: {
      files: children(flat, 'tls.certificates').length,
      defaultCertificate: has(flat, 'tls.stores.default.defaultcertificate'),
    },
  }
}

/** Version d'après l'image (`traefik:v3.5.1` → 3.5.1). */
export function versionFromImage(image: string): string | null {
  const m = /:v?(\d+(?:\.\d+){0,2})(?:[-@]|$)/.exec(image)
  return m ? m[1]! : null
}
