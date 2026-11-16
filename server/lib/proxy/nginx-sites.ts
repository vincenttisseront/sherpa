/**
 * Configuration nginx (fichier conf.d) des expositions d'une cible, pour un reverse proxy nginx
 * « classique » : un bloc server { } par nom d'hôte, une location par préfixe de chemin, proxy vers
 * l'alias unique du service (« <stack>-<service> ») sur le réseau du proxy, résolu à chaque requête
 * par le DNS de Docker (un conteneur arrêté n'empêche pas nginx de recharger sa configuration).
 * Fonction pure : le fichier est écrit puis nginx rechargé par le worker.
 */
import { aliasFor } from '../compose/unique-aliases'
import { byCode } from '../../../shared/utils/compare'
import { trimTrailingSlashes } from '../../../shared/utils/trim'

export interface NginxTlsFiles { certificate: string, key: string }

export interface NginxSitePolicy {
  redirectToHttps: boolean
  /** Chemins dans le conteneur nginx ; {host} remplacé par le domaine. Absents : HTTP seul. */
  sslCertificate: string | null
  sslCertificateKey: string | null
  /** Certificats déposés par la console, par domaine (prioritaires sur les chemins ci-dessus). */
  tls?: Readonly<Record<string, NginxTlsFiles>>
  /** Let's Encrypt par la console : dossier servi pour le défi HTTP-01 (port 80). */
  acmeWebroot?: string | null
  /** Journal d'accès : format de la console sur la sortie du conteneur, celui de nginx, ou aucun. */
  accessLog?: 'json' | 'default' | 'off'
}

/** Fichier du format de journal de la console (trié avant les fichiers des sites « platform-<stack> »). */
export const NGINX_LOG_FORMAT_FILE = 'platform--log-format.conf'
export const NGINX_LOG_FORMAT = 'platform_json'

/** Format JSON d'une ligne du journal d'accès (domaine, durées, amont), relu par la console. */
export function nginxLogFormatConfig(): string {
  const fields = [
    '"platform":1', '"time":"$time_iso8601"', '"host":"$host"', '"remote":"$remote_addr"', '"method":"$request_method"', '"uri":"$request_uri"',
    '"proto":"$server_protocol"', '"scheme":"$scheme"', '"status":$status', '"bytes":$body_bytes_sent', '"duration":$request_time',
    '"upstream":"$upstream_addr"', '"upstreamStatus":"$upstream_status"', '"upstreamTime":"$upstream_response_time"',
    '"referer":"$http_referer"', '"agent":"$http_user_agent"', '"forwardedFor":"$http_x_forwarded_for"',
  ]
  return [
    '# Géré par la console de déploiement : format du journal d\'accès des sites de la plateforme.',
    `log_format ${NGINX_LOG_FORMAT} escape=json '{${fields.join(',')}}';`,
    '',
  ].join('\n')
}

/** Racine des défis ACME servis par nginx (dans son conteneur). */
export const NGINX_ACME_WEBROOT = '/var/www/platform-acme'

/** Fichiers d'un domaine dans le dossier des certificats (« *.exemple.fr » : « _wildcard.exemple.fr »). */
export function nginxCertFiles(dir: string, host: string): NginxTlsFiles {
  const base = `${trimTrailingSlashes(dir)}/${host.toLowerCase().replace(/^\*\./, '_wildcard.').replace(/[^a-z0-9_.-]/g, '-')}`
  return { certificate: `${base}.crt`, key: `${base}.key` }
}

export interface CertCandidate { domains: readonly string[], notAfter: Date, isDefault: boolean, notBefore?: Date }

/**
 * Certificat d'un domaine : nom exact, puis générique (*.domaine), puis certificat par défaut ;
 * expirés écartés, le plus lointain d'abord à égalité.
 */
export function pickCertificate<T extends CertCandidate>(certs: readonly T[], host: string, now = Date.now()): T | null {
  const h = host.toLowerCase()
  const live = certs.filter(c => c.notAfter.getTime() > now).sort((a, b) => b.notAfter.getTime() - a.notAfter.getTime())
  const exact = live.find(c => c.domains.some(d => d.toLowerCase() === h))
  if (exact) return exact
  const wild = live.find(c => c.domains.some((d) => {
    const x = d.toLowerCase()
    return x.startsWith('*.') && h.endsWith(x.slice(1)) && !h.slice(0, -(x.length - 1)).includes('.')
  }))
  return wild ?? live.find(c => c.isDefault) ?? null
}

export interface NginxExposure { service: string, host: string, port: number, pathPrefix: string | null }

/** Nom du fichier de la cible dans conf.d (un fichier par stack : vidé quand la stack est retirée). */
export const nginxSiteFile = (stack: string) => `platform-${stack.replace(/[^A-Za-z0-9_.-]/g, '-')}.conf`

const HOST_RE = /^[a-z0-9*.-]+$/i
const PATH_RE = /^\/[A-Za-z0-9._~/-]*$/

function locations(list: readonly NginxExposure[], stack: string): string[] {
  // Préfixes les plus longs d'abord (lisibilité ; nginx choisit de toute façon le plus long).
  return [...list].sort((a, b) => (b.pathPrefix ?? '').length - (a.pathPrefix ?? '').length).flatMap(e => [
    `    location ${e.pathPrefix ?? '/'} {`,
    `        set $platform_upstream http://${aliasFor(stack, e.service)}:${e.port};`,
    '        proxy_pass $platform_upstream;',
    '        proxy_http_version 1.1;',
    '        proxy_set_header Host $host;',
    '        proxy_set_header X-Real-IP $remote_addr;',
    '        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;',
    '        proxy_set_header X-Forwarded-Proto $scheme;',
    '        proxy_set_header Upgrade $http_upgrade;',
    '        proxy_set_header Connection $http_connection;',
    '    }',
  ])
}

/** Renouvellement ACME (et remplacement d'un certificat importé) à moins de 30 jours de l'expiration. */
export const RENEW_BEFORE_MS = 30 * 864e5

/** Seuil de renouvellement : 30 jours, ou le tiers de la durée de vie pour un certificat court. */
export function renewThreshold(c: CertCandidate): number {
  return c.notBefore ? Math.min(RENEW_BEFORE_MS, (c.notAfter.getTime() - c.notBefore.getTime()) / 3) : RENEW_BEFORE_MS
}

/** Domaines servis par les fichiers de sites de la console (server_name des platform-*.conf). */
export function nginxServedHosts(files: readonly { path: string, content: string }[]): string[] {
  return [...new Set(files.filter(f => /(^|\/)platform-[^/]+\.conf$/.test(f.path))
    .flatMap(f => [...f.content.matchAll(/^[ \t]*server_name\s+([^;]+);/gm)].flatMap(m => m[1]!.trim().split(/\s+/))))].sort(byCode)
}

/** Domaines sans certificat propre (exact ou générique, hors défaut) encore valable au-delà du seuil de renouvellement. */
export function hostsNeedingAcme(certs: readonly CertCandidate[], hosts: readonly string[], now = Date.now()): string[] {
  const own = certs.map(c => ({ ...c, isDefault: false }))
  return [...new Set(hosts.map(x => x.toLowerCase()))].filter((host) => {
    const c = pickCertificate(own, host, now)
    return !c || c.notAfter.getTime() - now < renewThreshold(c)
  })
}

export function nginxSiteConfig(stack: string, owner: string, exposures: readonly NginxExposure[], policy: NginxSitePolicy): string {
  const head = [
    `# Géré par la console de déploiement : ${owner} (stack ${stack}).`,
    '# Réécrit à chaque déploiement, vidé quand la stack est retirée : ne pas modifier à la main.',
  ]
  const valid = exposures.filter(e => HOST_RE.test(e.host) && (e.pathPrefix === null || PATH_RE.test(e.pathPrefix)) && Number.isInteger(e.port))
  if (!valid.length) return `${head.join('\n')}\n`
  const byHost = new Map<string, NginxExposure[]>()
  for (const e of valid) byHost.set(e.host, [...(byHost.get(e.host) ?? []), e])
  const pattern = !!policy.sslCertificate && !!policy.sslCertificateKey
  const acme = policy.acmeWebroot
    ? ['    location ^~ /.well-known/acme-challenge/ {', `        root ${policy.acmeWebroot};`, '        default_type text/plain;', '    }']
    : []
  const blocks: string[] = []
  for (const [host, list] of byHost) {
    const common = [
      `    server_name ${host};`,
      '    resolver 127.0.0.11 valid=10s ipv6=off;',
      ...(policy.accessLog === 'json' ? [`    access_log /dev/stdout ${NGINX_LOG_FORMAT};`] : policy.accessLog === 'off' ? ['    access_log off;'] : []),
    ]
    const tls = policy.tls?.[host]
      ?? (pattern ? { certificate: policy.sslCertificate!.replaceAll('{host}', host), key: policy.sslCertificateKey!.replaceAll('{host}', host) } : null)
    if (tls) {
      // Défi ACME : servi avant la redirection (un « return » au niveau server passerait avant les locations).
      const redirect = acme.length ? ['    location / {', '        return 301 https://$host$request_uri;', '    }'] : ['    return 301 https://$host$request_uri;']
      blocks.push(
        'server {',
        '    listen 80;',
        ...common,
        ...acme,
        ...(policy.redirectToHttps ? redirect : locations(list, stack)),
        '}',
        'server {',
        '    listen 443 ssl;',
        ...common,
        `    ssl_certificate ${tls.certificate};`,
        `    ssl_certificate_key ${tls.key};`,
        ...locations(list, stack),
        '}',
      )
    }
    else {
      blocks.push('server {', '    listen 80;', ...common, ...acme, ...locations(list, stack), '}')
    }
  }
  return `${[...head, ...blocks].join('\n')}\n`
}
