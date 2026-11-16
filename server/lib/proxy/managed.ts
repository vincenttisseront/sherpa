/**
 * Compose du Traefik géré par la plateforme. Configuration par arguments de
 * lancement uniquement ; les identifiants DNS sont des références ${VAR}
 * (valeurs transmises par l'environnement de docker compose).
 */
import { stringify } from 'yaml'
import { MANAGED_RESOLVER, type ManagedProxyConfig } from '../../../shared/schemas/managed-proxy'

const LETS_ENCRYPT_STAGING = 'https://acme-staging-v02.api.letsencrypt.org/directory'

/** Certificat importé tel que transmis au Compose : clé courte (noms de fichiers et de variables), certificat par défaut. */
export interface ManagedCert { key: string, isDefault: boolean }

/** Variables d'environnement portant le certificat et la clé (valeurs transmises à docker compose, jamais écrites). */
export const certEnvNames = (key: string) => ({ cert: `PLATFORM_TLS_CERT_${key.toUpperCase()}`, key: `PLATFORM_TLS_KEY_${key.toUpperCase()}` })

const DYNAMIC_DIR = '/etc/traefik/dynamic'
const TLS_DYNAMIC = `${DYNAMIC_DIR}/tls.yml`
const ROUTES_DYNAMIC = `${DYNAMIC_DIR}/routes.yml`

/** Route vers un conteneur externe (fournisseur fichier). */
export interface ManagedRoute { id: string, containerName: string, host: string, pathPrefix: string | null, port: number, https: boolean }

/** Nom des routeurs et services Traefik d'une route (stable : identifiant de la route). */
export const routeKey = (id: string) => `ext-${id.replace(/-/g, '').slice(0, 12)}`

/** Configuration dynamique des routes vers des conteneurs externes, joints par leur nom sur le réseau du proxy. */
export function routesDynamicConfig(routes: readonly ManagedRoute[]): string {
  const routers: Record<string, unknown> = {}
  const services: Record<string, unknown> = {}
  for (const r of routes) {
    const k = routeKey(r.id)
    const rule = `Host(\`${r.host}\`)${r.pathPrefix ? ` && PathPrefix(\`${r.pathPrefix}\`)` : ''}`
    routers[k] = { rule, entryPoints: [r.https ? 'websecure' : 'web'], service: k, ...(r.https ? { tls: {} } : {}) }
    services[k] = { loadBalancer: { servers: [{ url: `http://${r.containerName}:${r.port}` }] } }
  }
  return stringify({ http: { routers, services } }, { lineWidth: 0 })
}

/** Configuration dynamique : certificats importés et, le cas échéant, certificat par défaut. */
export function tlsDynamicConfig(certs: readonly ManagedCert[]): string {
  const files = (k: string) => ({ certFile: `/etc/traefik/certs/${k}.crt`, keyFile: `/run/secrets/tls_${k}.key` })
  const def = certs.find(x => x.isDefault)
  const doc: Record<string, unknown> = { certificates: certs.map(x => files(x.key)) }
  if (def) doc.stores = { default: { defaultCertificate: files(def.key) } }
  return stringify({ tls: doc }, { lineWidth: 0 })
}

export function managedTraefikArgs(c: ManagedProxyConfig, certs: readonly ManagedCert[] = [], routes: readonly ManagedRoute[] = []): string[] {
  const args = [
    '--providers.docker=true',
    '--providers.docker.exposedbydefault=false',
    `--providers.docker.network=${c.networks[0]}`,
    '--entrypoints.web.address=:80',
    '--entrypoints.websecure.address=:443',
    `--log.level=${c.logLevel}`,
    '--ping=true',
    // Aucun appel sortant non nécessaire (vérification de version, statistiques anonymes).
    '--global.checknewversion=false',
    '--global.sendanonymoususage=false',
  ]
  // Seuls les conteneurs déployés par la plateforme sont routés.
  if (c.onlyManaged) args.push('--providers.docker.constraints=Label(`platform.managed`,`true`)')
  if (c.redirectToHttps) args.push('--entrypoints.web.http.redirections.entrypoint.to=websecure', '--entrypoints.web.http.redirections.entrypoint.scheme=https')
  if (c.acme.enabled) {
    const r = `--certificatesresolvers.${MANAGED_RESOLVER}.acme`
    args.push(`${r}.email=${c.acme.email}`, `${r}.storage=/letsencrypt/acme.json`)
    const ca = c.acme.caServer ?? (c.acme.staging ? LETS_ENCRYPT_STAGING : null)
    if (ca) args.push(`${r}.caserver=${ca}`)
    if (c.acme.challenge === 'http') args.push(`${r}.httpchallenge.entrypoint=web`)
    else if (c.acme.challenge === 'tls') args.push(`${r}.tlschallenge=true`)
    else args.push(`${r}.dnschallenge.provider=${c.acme.dnsProvider}`)
    // Résolveur par défaut des routes HTTPS : les projets n'ont rien à déclarer.
    args.push(`--entrypoints.websecure.http.tls.certresolver=${MANAGED_RESOLVER}`)
  }
  // Fournisseur fichier : certificats importés (prioritaires sur ACME pour les domaines qu'ils couvrent)
  // et routes vers des conteneurs externes.
  if (certs.length || routes.length) args.push(`--providers.file.directory=${DYNAMIC_DIR}`, '--providers.file.watch=false')
  return args
}

export function managedTraefikCompose(c: ManagedProxyConfig, dnsEnvNames: readonly string[], certs: readonly ManagedCert[] = [], routes: readonly ManagedRoute[] = []): string {
  const bind = c.bindAddress === '0.0.0.0' ? '' : `${c.bindAddress}:`
  const service: Record<string, unknown> = {
    image: c.image,
    command: managedTraefikArgs(c, certs, routes).map(a => a.replace(/\$/g, '$$$$')),
    ports: [`${bind}${c.httpPort}:80`, `${bind}${c.httpsPort}:443`],
    volumes: ['/var/run/docker.sock:/var/run/docker.sock:ro', ...(c.acme.enabled ? ['letsencrypt:/letsencrypt'] : [])],
    networks: [...c.networks],
    restart: 'unless-stopped',
    healthcheck: { test: ['CMD', 'traefik', 'healthcheck', '--ping'], interval: '15s', timeout: '5s', retries: 3 },
    labels: { 'platform.managed': 'true', 'platform.infra': 'traefik' },
  }
  if (c.acme.enabled && c.acme.challenge === 'dns' && dnsEnvNames.length) {
    service.environment = Object.fromEntries(dnsEnvNames.map(n => [n, `\${${n}}`]))
  }
  const doc: Record<string, unknown> = {
    services: { traefik: service },
    networks: Object.fromEntries(c.networks.map(n => [n, { external: true, name: n }])),
  }
  if (c.acme.enabled) doc.volumes = { letsencrypt: {} }
  const configs: Record<string, unknown>[] = []
  const configDefs: Record<string, unknown> = {}
  if (certs.length) {
    // Certificat (public) en « config », clé en « secret » : valeurs lues dans l'environnement de docker compose.
    configs.push({ source: 'platform_tls', target: TLS_DYNAMIC }, ...certs.map(x => ({ source: `cert_${x.key}`, target: `/etc/traefik/certs/${x.key}.crt` })))
    // Clé lisible par root seul (Traefik s'exécute en root dans son conteneur) : mode 0400.
    service.secrets = certs.map(x => ({ source: `key_${x.key}`, target: `tls_${x.key}.key`, mode: 0o400 }))
    Object.assign(configDefs, {
      platform_tls: { content: tlsDynamicConfig(certs).replace(/\$/g, '$$$$') },
      ...Object.fromEntries(certs.map(x => [`cert_${x.key}`, { content: `\${${certEnvNames(x.key).cert}}` }])),
    })
    doc.secrets = Object.fromEntries(certs.map(x => [`key_${x.key}`, { environment: certEnvNames(x.key).key }]))
  }
  if (routes.length) {
    configs.push({ source: 'platform_routes', target: ROUTES_DYNAMIC })
    configDefs.platform_routes = { content: routesDynamicConfig(routes).replace(/\$/g, '$$$$') }
  }
  if (configs.length) {
    service.configs = configs
    doc.configs = configDefs
  }
  return `# Traefik géré par la plateforme : ne pas modifier à la main.\n${stringify(doc, { lineWidth: 0 })}`
}
