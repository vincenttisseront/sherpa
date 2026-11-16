/**
 * Contrats de configuration d'infrastructure : endpoints, réseaux, chemins,
 * ports, domaines et Traefik. Partagés entre l'assistant (§5.1), les écrans
 * d'administration et l'API. Les règles de sécurité des chemins sont
 * revérifiées côté serveur par path-guard : ce schéma ne fait que la forme.
 */
import { z } from 'zod'
import { environmentKey } from './common'

const absolutePath = z.string().trim().min(2).max(1024).startsWith('/', 'Chemin absolu attendu')

export const pathConfigInput = z.object({
  workingRoot: absolutePath,
  buildRoot: absolutePath,
  tmpRoot: absolutePath,
  runtimeRoot: absolutePath,
  autoCreate: z.boolean().default(true),
  dirMode: z.string().regex(/^0[0-7]{3}$/, 'Mode octal attendu (ex. 0750)').default('0750'),
  ownerUid: z.number().int().min(0).max(4_294_967_294).nullable().default(null),
  groupGid: z.number().int().min(0).max(4_294_967_294).nullable().default(null),
  minFreeDiskMb: z.number().int().min(0).max(10_000_000).default(2_048),
  maxProjectSizeMb: z.number().int().min(1).max(1_000_000).default(1_024),
  releasesToKeep: z.number().int().min(1).max(100).default(5),
  retentionDays: z.number().int().min(1).max(3650).default(90),
  forbiddenPaths: z.array(absolutePath).max(50).default([]),
})
export type PathConfigInput = z.infer<typeof pathConfigInput>

/** Valeurs proposées par défaut pour un environnement (§6.4). */
export function defaultPathConfig(env: string): PathConfigInput {
  return {
    workingRoot: `/srv/deployments/${env}`,
    buildRoot: `/srv/builds/${env}`,
    tmpRoot: `/srv/tmp/${env}`,
    runtimeRoot: `/srv/apps-data/${env}`,
    autoCreate: true,
    dirMode: '0750',
    ownerUid: null,
    groupGid: null,
    minFreeDiskMb: 2_048,
    maxProjectSizeMb: 1_024,
    releasesToKeep: 5,
    retentionDays: 90,
    forbiddenPaths: [],
  }
}

export const PORT_POLICIES = ['allowed', 'approval', 'forbidden'] as const

export const portRuleInput = z.object({
  portFrom: z.number().int().min(1).max(65535),
  portTo: z.number().int().min(1).max(65535),
  protocol: z.enum(['tcp', 'udp']).default('tcp'),
  policy: z.enum(PORT_POLICIES),
  environmentKey: environmentKey.nullable().default(null),
  description: z.string().trim().max(200).nullable().default(null),
}).refine(r => r.portTo >= r.portFrom, { message: 'Plage de ports invalide', path: ['portTo'] })
export type PortRuleInput = z.infer<typeof portRuleInput>

/**
 * Motif de domaine autorisé : `app.exemple.fr` ou `*.apps.exemple.fr` (au moins
 * deux niveaux après le joker, pour interdire `*.com`). Seule exception :
 * `*.localhost`, domaine réservé au développement (RFC 6761).
 */
export const DOMAIN_PATTERN_RE = /^(?:(?:\*\.)?(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}|\*\.localhost)$/
export const domainPattern = z.string().trim().toLowerCase().regex(DOMAIN_PATTERN_RE, 'Domaine invalide (ex. *.apps.interne.fr)')

const traefikName = z.string().trim().regex(/^[A-Za-z0-9][A-Za-z0-9_.@-]{0,99}$/, 'Nom invalide')

/** Reverse proxies pris en charge pour exposer les projets. */
export const PROXY_PROVIDERS = ['traefik', 'nginx-proxy', 'nginx'] as const
export type ProxyProvider = (typeof PROXY_PROVIDERS)[number]
export const PROXY_PROVIDER_LABEL: Record<ProxyProvider, string> = { 'traefik': 'Traefik', 'nginx-proxy': 'nginx-proxy', 'nginx': 'nginx' }

export const traefikConfigInput = z.object({
  networkName: z.string().trim().min(1).max(200),
  certResolver: traefikName.nullable().default(null),
  entrypointHttp: traefikName.default('web'),
  entrypointHttps: traefikName.default('websecure'),
  allowedDomains: z.array(domainPattern).max(100).default([]),
  defaultMiddlewares: z.array(traefikName).max(20).default([]),
  routerNamePattern: z.string().trim().regex(/^[a-z0-9{}_-]+$/, 'Caractères autorisés : a-z 0-9 - _ et {project} {env} {service}').default('{project}-{env}-{service}'),
  exposure: z.enum(['internal', 'external']).default('internal'),
  redirectToHttps: z.boolean().default(true),
  /** Reverse proxy de l'endpoint (la configuration Traefik vaut pour les trois). */
  provider: z.enum(PROXY_PROVIDERS).default('traefik'),
  letsencrypt: z.boolean().default(false),
  nginxContainer: z.string().trim().regex(/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/, 'Nom de conteneur invalide').nullable().default(null),
  nginxConfDir: z.string().trim().regex(/^\/[A-Za-z0-9._/-]{1,200}$/, 'Chemin absolu attendu').default('/etc/nginx/conf.d'),
  nginxSslCertificate: z.string().trim().regex(/^\/[A-Za-z0-9._/{}-]{1,250}$/, 'Chemin absolu attendu ({host} remplacé par le domaine)').nullable().default(null),
  nginxSslCertificateKey: z.string().trim().regex(/^\/[A-Za-z0-9._/{}-]{1,250}$/, 'Chemin absolu attendu ({host} remplacé par le domaine)').nullable().default(null),
  nginxCertsDir: z.string().trim().regex(/^\/[A-Za-z0-9._/-]{1,200}$/, 'Chemin absolu attendu').default('/etc/nginx/platform-certs'),
  nginxAcmeEmail: z.email('Adresse e-mail invalide').max(254).nullable().default(null),
  nginxAccessLog: z.enum(['json', 'default', 'off']).default('json'),
  nginxAcmeDirectory: z.union([z.enum(['letsencrypt', 'letsencrypt-staging']), z.url({ protocol: /^https$/ }).max(500)]).default('letsencrypt'),
})
export type TraefikConfigInput = z.infer<typeof traefikConfigInput>

/** Réglages propres à nginx, par défaut (Traefik) : à fusionner dans une configuration construite à la main. */
export const PROXY_DEFAULTS = { provider: 'traefik', letsencrypt: false, nginxContainer: null, nginxConfDir: '/etc/nginx/conf.d', nginxSslCertificate: null, nginxSslCertificateKey: null, nginxCertsDir: '/etc/nginx/platform-certs', nginxAcmeEmail: null, nginxAcmeDirectory: 'letsencrypt', nginxAccessLog: 'json' } as const satisfies Pick<TraefikConfigInput, 'provider' | 'letsencrypt' | 'nginxContainer' | 'nginxConfDir' | 'nginxSslCertificate' | 'nginxSslCertificateKey' | 'nginxCertsDir' | 'nginxAcmeEmail' | 'nginxAcmeDirectory' | 'nginxAccessLog'>

export const NETWORK_POLICIES = ['unreviewed', 'allowed', 'forbidden'] as const
export const NETWORK_ROLES = ['none', 'traefik', 'app'] as const

export const networkDecision = z.object({
  policy: z.enum(NETWORK_POLICIES),
  role: z.enum(NETWORK_ROLES),
  external: z.boolean().default(true),
  description: z.string().trim().max(500).nullable().default(null),
  tags: z.array(z.string().trim().min(1).max(50)).max(20).default([]),
  allowedEnvironmentKeys: z.array(environmentKey).default([]),
})
export type NetworkDecision = z.infer<typeof networkDecision>

export const networkPatch = networkDecision.partial()

/** Réseaux Docker système, interdits par défaut : jamais utilisables par un projet. */
export const SYSTEM_NETWORKS = ['bridge', 'host', 'none', 'ingress', 'docker_gwbridge'] as const

export const endpointPatch = z.object({
  enabled: z.boolean().optional(),
  environmentKeys: z.array(environmentKey).optional(),
})

// ---------------------------------------------------------------------------
// Assistant de connexion : charge utile finale
// ---------------------------------------------------------------------------

export const wizardEndpointInput = z.object({
  portainerEndpointId: z.number().int().positive(),
  enabled: z.boolean(),
  environmentKeys: z.array(environmentKey).default([]),
  /** Décisions par nom de réseau ; les métadonnées viennent de la découverte serveur. */
  networks: z.record(z.string(), networkDecision).default({}),
  paths: z.array(pathConfigInput.extend({ environmentKey })).default([]),
  portRules: z.array(portRuleInput).default([]),
  traefik: traefikConfigInput.nullable().default(null),
})
export type WizardEndpointInput = z.infer<typeof wizardEndpointInput>

// ---------------------------------------------------------------------------
// Représentations renvoyées par l'API
// ---------------------------------------------------------------------------

export interface DiscoveredNetwork {
  id: string
  name: string
  driver: string
  scope: string
  internal: boolean
  attachable: boolean
  labels: Record<string, string>
  /** Stacks (projets Compose) dont des conteneurs sont attachés au réseau, au moment de la découverte. */
  stacks?: string[]
}

export interface DiscoveredEndpoint {
  id: number
  name: string
  kind: string
  url: string | null
  online: boolean
  /** Seul Docker Standalone est déployable dans le MVP. */
  supported: boolean
  networks: DiscoveredNetwork[]
  volumes: { name: string, driver: string, mountpoint: string | null }[]
  inventory: { containers: number, running: number, images: number, stacks: number, traefik: { container: string, image: string, networks: string[] } | null, proxies?: { kind: string, container: string, image: string }[], composeProjects?: number }
  error?: string
}

export interface DiscoveryPreview {
  version: string
  capabilities: Record<string, boolean>
  endpoints: DiscoveredEndpoint[]
}

export type FieldErrors = Record<string, string>

// ---------------------------------------------------------------------------
// Target Runner et volumes bind
// ---------------------------------------------------------------------------

export const runnerConfigInput = z.object({
  url: z.url({ protocol: /^https?$/ }).transform(u => u.replace(/\/+$/, '')),
  caCertPem: z.string().trim().max(20_000).refine(v => v.includes('-----BEGIN CERTIFICATE-----'), 'Certificat PEM attendu').nullable().default(null),
  serverName: z.string().trim().regex(/^[a-z0-9.-]{1,253}$/i, 'Nom d\'hôte invalide').nullable().default(null),
  maxConcurrentBuilds: z.number().int().min(1).max(16).default(2),
})
export type RunnerConfigInput = z.infer<typeof runnerConfigInput>

export const volumeRuleInput = z.object({
  hostPath: z.string().trim().min(2).max(1024).startsWith('/', 'Chemin absolu attendu'),
  mode: z.enum(['ro', 'rw']).default('ro'),
  environmentKey: environmentKey.nullable().default(null),
  description: z.string().trim().max(300).nullable().default(null),
  enabled: z.boolean().default(true),
})
export type VolumeRuleInput = z.infer<typeof volumeRuleInput>
