/**
 * Modèle de données — PostgreSQL est la source de vérité (§20).
 *
 * Conventions :
 * - identifiants uuid v4 générés par la base, sauf tables d'événements (bigserial) ;
 * - aucun secret en clair : les valeurs sensibles vivent dans `secrets`
 *   (chiffrées AES-256-GCM, clé maîtresse hors base) et sont référencées par id ;
 * - les objets découverts depuis Portainer sont rattachés à un endpoint, pas
 *   directement au serveur, pour supporter plusieurs endpoints par serveur.
 */
import type { WatchtowerConfig } from '../../shared/schemas/watchtower'
import type { TargetHealthState } from '../../shared/schemas/dashboard'
import type { TargetAdoption } from '../../shared/schemas/adoption'
import type { AutoRebuildState } from '../../shared/schemas/rebuild'
import type { GithubScanSnapshot } from '../../shared/schemas/github-connector'
import type { Finding, ImageScanDto, SeverityCounts } from '../../shared/schemas/trivy'
import type { ComposeOverrides } from '../../shared/schemas/projects'
import type { NetworkPool } from '../../shared/schemas/network-pool'
import { sql } from 'drizzle-orm'
import {
  bigint,
  bigserial,
  boolean,
  check,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  primaryKey,
  real,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core'
import { DEPLOYMENT_STATUSES } from '../../shared/utils/deployment-status'

export interface EndpointInventory {
  containers: number
  running: number
  images: number
  stacks: number
  /** Conteneur Traefik détecté et réseaux auxquels il est attaché. */
  traefik: { container: string, image: string, networks: string[] } | null
  /** Reverse proxies reconnus (Traefik, nginx, Caddy, HAProxy…). */
  proxies?: { kind: string, container: string, image: string }[]
  /** Projets Compose présents, gérés ou non par la plateforme. */
  composeProjects?: number
}

const id = () => uuid('id').primaryKey().defaultRandom()
const createdAt = () => timestamp('created_at', { withTimezone: true }).notNull().defaultNow()
const updatedAt = () => timestamp('updated_at', { withTimezone: true }).notNull().defaultNow().$onUpdate(() => new Date())

// ---------------------------------------------------------------------------
// Enums
// ---------------------------------------------------------------------------

export const userKind = pgEnum('user_kind', ['local', 'sso', 'external'])
export const userStatus = pgEnum('user_status', ['invited', 'active', 'suspended', 'locked', 'expired'])
export const idpKind = pgEnum('idp_kind', ['keycloak', 'okta', 'oidc'])
export const subjectType = pgEnum('subject_type', ['user', 'group'])
export const serverStatus = pgEnum('server_status', ['unknown', 'online', 'degraded', 'offline'])
/** Transport vers l'hôte : agent Portainer, ou SSH (mot de passe ou clé) sans agent ni Runner. */
export const hostTransport = pgEnum('host_transport', ['agent', 'ssh'])
export const sshAuthMethod = pgEnum('ssh_auth_method', ['password', 'key'])
export const endpointType = pgEnum('endpoint_type', ['docker_standalone', 'docker_swarm', 'kubernetes', 'other'])
export const runnerStatus = pgEnum('runner_status', ['unconfigured', 'online', 'offline', 'error'])
export const policyStatus = pgEnum('policy_status', ['unreviewed', 'allowed', 'forbidden'])
export const networkRole = pgEnum('network_role', ['none', 'traefik', 'app'])
export const accessMode = pgEnum('access_mode', ['ro', 'rw'])
export const portProtocol = pgEnum('port_protocol', ['tcp', 'udp'])
export const portPolicy = pgEnum('port_policy', ['allowed', 'approval', 'forbidden'])
export const exposure = pgEnum('exposure', ['internal', 'external'])
export const sourceKind = pgEnum('source_kind', ['github', 'zip'])
export const gitRefType = pgEnum('git_ref_type', ['branch', 'tag', 'commit'])
export const deploymentAction = pgEnum('deployment_action', ['deploy', 'redeploy', 'stop', 'start', 'restart', 'delete', 'rollback', 'migrate'])
export const deploymentStatus = pgEnum('deployment_status', DEPLOYMENT_STATUSES)
export const logLevel = pgEnum('log_level', ['debug', 'info', 'warn', 'error'])
export const logPhase = pgEnum('log_phase', ['validation', 'extraction', 'build', 'portainer', 'service', 'healthcheck', 'system'])
export const imageUpdateKind = pgEnum('image_update_kind', ['updated', 'available', 'failed', 'external'])
export const auditOutcome = pgEnum('audit_outcome', ['success', 'failure', 'denied'])
export const notificationKind = pgEnum('notification_kind', ['email', 'teams_webhook', 'teams_graph', 'slack_webhook', 'discord_webhook', 'ntfy', 'gotify'])

// ---------------------------------------------------------------------------
// Secrets chiffrés
// ---------------------------------------------------------------------------

export const secrets = pgTable('secrets', {
  id: id(),
  /** Usage du secret, pour l'inventaire et la rotation (portainer_token, github_token, ...). */
  purpose: text('purpose').notNull(),
  /** Enveloppe `v1.<keyId>.<iv>.<tag>.<ciphertext>` (base64url). */
  envelope: text('envelope').notNull(),
  keyId: text('key_id').notNull(),
  createdAt: createdAt(),
  rotatedAt: timestamp('rotated_at', { withTimezone: true }),
})

// ---------------------------------------------------------------------------
// Environnements
// ---------------------------------------------------------------------------

export const environments = pgTable('environments', {
  id: id(),
  key: text('key').notNull().unique(),
  name: text('name').notNull(),
  sortOrder: integer('sort_order').notNull().default(0),
  isProduction: boolean('is_production').notNull().default(false),
  createdAt: createdAt(),
})

// ---------------------------------------------------------------------------
// Identité, groupes, RBAC
// ---------------------------------------------------------------------------

export const identityProviders = pgTable('identity_providers', {
  id: id(),
  key: text('key').notNull().unique(),
  kind: idpKind('kind').notNull(),
  name: text('name').notNull(),
  issuerUrl: text('issuer_url').notNull(),
  clientId: text('client_id').notNull(),
  clientSecretId: uuid('client_secret_id').references(() => secrets.id),
  scopes: text('scopes').array().notNull().default(sql`ARRAY['openid','profile','email']::text[]`),
  groupsClaim: text('groups_claim').notNull().default('groups'),
  /** Refuse la connexion d'un utilisateur dont aucun groupe IdP n'est mappé (accès refusé par défaut). */
  requireMappedGroup: boolean('require_mapped_group').notNull().default(true),
  /** Domaines d'email acceptés (vide : tous). */
  allowedEmailDomains: text('allowed_email_domains').array().notNull().default(sql`'{}'::text[]`),
  enabled: boolean('enabled').notNull().default(true),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
})

export const users = pgTable('users', {
  id: id(),
  email: text('email').notNull(),
  displayName: text('display_name').notNull(),
  kind: userKind('kind').notNull(),
  status: userStatus('status').notNull().default('active'),
  /** Argon2id, comptes locaux uniquement. */
  passwordHash: text('password_hash'),
  idpId: uuid('idp_id').references(() => identityProviders.id),
  idpSubject: text('idp_subject'),
  failedLoginCount: integer('failed_login_count').notNull().default(0),
  lockedUntil: timestamp('locked_until', { withTimezone: true }),
  passwordChangedAt: timestamp('password_changed_at', { withTimezone: true }),
  expiresAt: timestamp('expires_at', { withTimezone: true }),
  lastLoginAt: timestamp('last_login_at', { withTimezone: true }),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
}, t => [
  uniqueIndex('users_email_lower_uq').on(sql`lower(${t.email})`),
  uniqueIndex('users_idp_subject_uq').on(t.idpId, t.idpSubject),
  check('users_local_password', sql`${t.kind} <> 'sso' OR ${t.passwordHash} IS NULL`),
])

export const invitations = pgTable('invitations', {
  id: id(),
  userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  /** Hash SHA-256 du jeton envoyé par email ; le jeton lui-même n'est jamais stocké. */
  tokenHash: text('token_hash').notNull().unique(),
  /** invite : premier mot de passe ; reset : réinitialisation. */
  purpose: text('purpose').notNull().default('invite'),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  usedAt: timestamp('used_at', { withTimezone: true }),
  createdBy: uuid('created_by').references(() => users.id),
  createdAt: createdAt(),
})

export const sessions = pgTable('sessions', {
  /** Hash de l'identifiant de session (le cookie porte la valeur brute). */
  id: text('id').primaryKey(),
  userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  idpId: uuid('idp_id').references(() => identityProviders.id),
  ip: text('ip'),
  userAgent: text('user_agent'),
  /** Jeton CSRF lié à la session, exigé sur toute requête modifiante. */
  csrfToken: text('csrf_token').notNull().default(''),
  createdAt: createdAt(),
  lastSeenAt: timestamp('last_seen_at', { withTimezone: true }).notNull().defaultNow(),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  revokedAt: timestamp('revoked_at', { withTimezone: true }),
  /** Double authentification exigée par la politique mais pas encore configurée : l'API se limite au compte jusqu'à son activation. */
  mfaPending: boolean('mfa_pending').notNull().default(false),
  /** Facteur utilisé à l'ouverture : password (seul), totp, recovery, passkey. */
  mfaMethod: text('mfa_method'),
}, t => [index('sessions_user_idx').on(t.userId)])

export const groups = pgTable('groups', {
  id: id(),
  name: text('name').notNull().unique(),
  description: text('description'),
  createdAt: createdAt(),
})

export const userGroups = pgTable('user_groups', {
  userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  groupId: uuid('group_id').notNull().references(() => groups.id, { onDelete: 'cascade' }),
  /** Appartenance issue d'un IdP (resynchronisée à la connexion) ou manuelle. */
  fromIdp: boolean('from_idp').notNull().default(false),
}, t => [primaryKey({ columns: [t.userId, t.groupId] })])

/** Mapping groupe IdP → groupe interne (§15). */
export const idpGroupMappings = pgTable('idp_group_mappings', {
  id: id(),
  idpId: uuid('idp_id').notNull().references(() => identityProviders.id, { onDelete: 'cascade' }),
  externalGroup: text('external_group').notNull(),
  groupId: uuid('group_id').notNull().references(() => groups.id, { onDelete: 'cascade' }),
}, t => [uniqueIndex('idp_group_mappings_uq').on(t.idpId, t.externalGroup, t.groupId)])

export const roles = pgTable('roles', {
  id: id(),
  key: text('key').notNull().unique(),
  name: text('name').notNull(),
  description: text('description'),
  builtin: boolean('builtin').notNull().default(false),
  permissions: text('permissions').array().notNull(),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
})

/**
 * Attribution d'un rôle à un utilisateur ou un groupe, dans une portée.
 * Une colonne de portée NULL signifie « toutes les valeurs ».
 */
export const roleBindings = pgTable('role_bindings', {
  id: id(),
  roleId: uuid('role_id').notNull().references(() => roles.id, { onDelete: 'cascade' }),
  subjectType: subjectType('subject_type').notNull(),
  subjectId: uuid('subject_id').notNull(),
  serverId: uuid('server_id').references(() => portainerServers.id, { onDelete: 'cascade' }),
  environmentId: uuid('environment_id').references(() => environments.id, { onDelete: 'cascade' }),
  projectId: uuid('project_id').references(() => projects.id, { onDelete: 'cascade' }),
  createdBy: uuid('created_by').references(() => users.id),
  createdAt: createdAt(),
}, t => [index('role_bindings_subject_idx').on(t.subjectType, t.subjectId)])

// ---------------------------------------------------------------------------
// Portainer
// ---------------------------------------------------------------------------

export const portainerServers = pgTable('portainer_servers', {
  id: id(),
  name: text('name').notNull().unique(),
  description: text('description'),
  transport: hostTransport('transport').notNull().default('agent'),
  /** Agent : https://hôte:9001. SSH : ssh://utilisateur@hôte:port (affichage, unicité). */
  url: text('url').notNull(),
  /** Agent : AGENT_SECRET. SSH : mot de passe ou clé privée (+ phrase de passe), JSON. Toujours chiffré. */
  tokenSecretId: uuid('token_secret_id').notNull().references(() => secrets.id),
  sshHost: text('ssh_host'),
  sshPort: integer('ssh_port'),
  sshUser: text('ssh_user'),
  sshAuth: sshAuthMethod('ssh_auth'),
  /** Empreinte confirmée de la clé d'hôte (SHA256:…) et son type ; null : à confirmer. */
  sshHostKey: text('ssh_host_key'),
  sshHostKeyType: text('ssh_host_key_type'),
  /** Socket Docker sur l'hôte (SSH). */
  dockerSocket: text('docker_socket').notNull().default('/var/run/docker.sock'),
  tlsVerify: boolean('tls_verify').notNull().default(true),
  caCertPem: text('ca_cert_pem'),
  detectedVersion: text('detected_version'),
  status: serverStatus('status').notNull().default('unknown'),
  tags: text('tags').array().notNull().default(sql`'{}'::text[]`),
  capabilities: jsonb('capabilities').$type<Record<string, boolean>>().notNull().default({}),
  lastCheckedAt: timestamp('last_checked_at', { withTimezone: true }),
  lastDiscoveryAt: timestamp('last_discovery_at', { withTimezone: true }),
  lastError: text('last_error'),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
})

export const serverEndpoints = pgTable('server_endpoints', {
  id: id(),
  serverId: uuid('server_id').notNull().references(() => portainerServers.id, { onDelete: 'cascade' }),
  portainerEndpointId: integer('portainer_endpoint_id').notNull(),
  name: text('name').notNull(),
  type: endpointType('type').notNull(),
  url: text('url'),
  online: boolean('online').notNull().default(false),
  /** Un endpoint non activé est découvert mais inutilisable pour déployer. */
  enabled: boolean('enabled').notNull().default(false),
  /** Plus présent dans Portainer lors de la dernière découverte. */
  missing: boolean('missing').notNull().default(false),
  /** Synthèse de la dernière découverte (conteneurs, images, stacks, Traefik détecté). */
  inventory: jsonb('inventory').$type<EndpointInventory>().notNull().default({ containers: 0, running: 0, images: 0, stacks: 0, traefik: null }),
  discoveredAt: timestamp('discovered_at', { withTimezone: true }).notNull().defaultNow(),
  /**
   * Plage d'adresses des réseaux des projets (ex. 10.210.0.0/16 découpée en /27) ; null : sous-réseaux
   * attribués par Docker (/16 par défaut, ou default-address-pools du démon).
   */
  networkPool: jsonb('network_pool').$type<NetworkPool | null>(),
}, t => [uniqueIndex('server_endpoints_uq').on(t.serverId, t.portainerEndpointId)])

/** Environnements (dev/staging/prod) servis par un endpoint. */
export const endpointEnvironments = pgTable('endpoint_environments', {
  endpointId: uuid('endpoint_id').notNull().references(() => serverEndpoints.id, { onDelete: 'cascade' }),
  environmentId: uuid('environment_id').notNull().references(() => environments.id, { onDelete: 'cascade' }),
}, t => [primaryKey({ columns: [t.endpointId, t.environmentId] })])

export const targetRunners = pgTable('target_runners', {
  id: id(),
  endpointId: uuid('endpoint_id').notNull().unique().references(() => serverEndpoints.id, { onDelete: 'cascade' }),
  url: text('url').notNull(),
  /** Clé HMAC propre à ce Runner, chiffrée. Le certificat client mTLS est celui de la plateforme. */
  authSecretId: uuid('auth_secret_id').references(() => secrets.id),
  /** AC ayant signé le certificat serveur du Runner. */
  caCertPem: text('ca_cert_pem'),
  /** Nom attendu dans le certificat du Runner, si différent de l'hôte de l'URL. */
  serverName: text('server_name'),
  /** Racines déclarées sur l'hôte, relevées au dernier contrôle. */
  hostRoots: text('host_roots').array().notNull().default(sql`'{}'::text[]`),
  hostname: text('hostname'),
  status: runnerStatus('status').notNull().default('unconfigured'),
  version: text('version'),
  allowedActions: text('allowed_actions').array().notNull().default(sql`'{}'::text[]`),
  maxConcurrentBuilds: integer('max_concurrent_builds').notNull().default(2),
  lastCheckedAt: timestamp('last_checked_at', { withTimezone: true }),
  lastError: text('last_error'),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
})

// ---------------------------------------------------------------------------
// Répertoires de travail (§6)
// ---------------------------------------------------------------------------

export const pathConfigs = pgTable('path_configs', {
  id: id(),
  endpointId: uuid('endpoint_id').notNull().references(() => serverEndpoints.id, { onDelete: 'cascade' }),
  environmentId: uuid('environment_id').notNull().references(() => environments.id, { onDelete: 'cascade' }),
  workingRoot: text('working_root').notNull(),
  buildRoot: text('build_root').notNull(),
  tmpRoot: text('tmp_root').notNull(),
  runtimeRoot: text('runtime_root').notNull(),
  autoCreate: boolean('auto_create').notNull().default(true),
  dirMode: text('dir_mode').notNull().default('0750'),
  ownerUid: integer('owner_uid'),
  groupGid: integer('group_gid'),
  minFreeDiskMb: integer('min_free_disk_mb').notNull().default(2_048),
  maxProjectSizeMb: integer('max_project_size_mb').notNull().default(1_024),
  releasesToKeep: integer('releases_to_keep').notNull().default(5),
  retentionDays: integer('retention_days').notNull().default(90),
  forbiddenPaths: text('forbidden_paths').array().notNull().default(sql`'{}'::text[]`),
  updatedBy: uuid('updated_by').references(() => users.id),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
}, t => [uniqueIndex('path_configs_uq').on(t.endpointId, t.environmentId)])

// ---------------------------------------------------------------------------
// Réseaux, volumes, ports, Traefik (§10, §11)
// ---------------------------------------------------------------------------

export const networks = pgTable('networks', {
  id: id(),
  endpointId: uuid('endpoint_id').notNull().references(() => serverEndpoints.id, { onDelete: 'cascade' }),
  dockerId: text('docker_id').notNull(),
  name: text('name').notNull(),
  driver: text('driver'),
  scope: text('scope'),
  internal: boolean('internal').notNull().default(false),
  labels: jsonb('labels').$type<Record<string, string>>().notNull().default({}),
  /** Politique décidée par l'administrateur ; jamais modifiée par la découverte. */
  policy: policyStatus('policy').notNull().default('unreviewed'),
  role: networkRole('role').notNull().default('none'),
  external: boolean('external').notNull().default(true),
  description: text('description'),
  tags: text('tags').array().notNull().default(sql`'{}'::text[]`),
  allowedEnvironmentIds: uuid('allowed_environment_ids').array().notNull().default(sql`'{}'::uuid[]`),
  /** Plus présent lors de la dernière découverte. */
  missing: boolean('missing').notNull().default(false),
  discoveredAt: timestamp('discovered_at', { withTimezone: true }).notNull().defaultNow(),
}, t => [uniqueIndex('networks_uq').on(t.endpointId, t.name)])

export const dockerVolumes = pgTable('docker_volumes', {
  id: id(),
  endpointId: uuid('endpoint_id').notNull().references(() => serverEndpoints.id, { onDelete: 'cascade' }),
  name: text('name').notNull(),
  driver: text('driver'),
  mountpoint: text('mountpoint'),
  labels: jsonb('labels').$type<Record<string, string>>().notNull().default({}),
  missing: boolean('missing').notNull().default(false),
  discoveredAt: timestamp('discovered_at', { withTimezone: true }).notNull().defaultNow(),
}, t => [uniqueIndex('docker_volumes_uq').on(t.endpointId, t.name)])

/** Whitelist des chemins bind (§10). */
export const volumeRules = pgTable('volume_rules', {
  id: id(),
  endpointId: uuid('endpoint_id').notNull().references(() => serverEndpoints.id, { onDelete: 'cascade' }),
  hostPath: text('host_path').notNull(),
  mode: accessMode('mode').notNull().default('ro'),
  projectId: uuid('project_id').references(() => projects.id, { onDelete: 'cascade' }),
  environmentId: uuid('environment_id').references(() => environments.id, { onDelete: 'cascade' }),
  description: text('description'),
  enabled: boolean('enabled').notNull().default(true),
  createdBy: uuid('created_by').references(() => users.id),
  createdAt: createdAt(),
})

/** Règles de ports. endpointId NULL = règle globale. */
export const portRules = pgTable('port_rules', {
  id: id(),
  endpointId: uuid('endpoint_id').references(() => serverEndpoints.id, { onDelete: 'cascade' }),
  environmentId: uuid('environment_id').references(() => environments.id, { onDelete: 'cascade' }),
  portFrom: integer('port_from').notNull(),
  portTo: integer('port_to').notNull(),
  protocol: portProtocol('protocol').notNull().default('tcp'),
  policy: portPolicy('policy').notNull(),
  description: text('description'),
  createdAt: createdAt(),
}, t => [check('port_rules_range', sql`${t.portFrom} BETWEEN 1 AND 65535 AND ${t.portTo} BETWEEN ${t.portFrom} AND 65535`)])

export const traefikConfigs = pgTable('traefik_configs', {
  id: id(),
  endpointId: uuid('endpoint_id').notNull().references(() => serverEndpoints.id, { onDelete: 'cascade' }),
  /** NULL = configuration par défaut de l'endpoint. */
  environmentId: uuid('environment_id').references(() => environments.id, { onDelete: 'cascade' }),
  networkName: text('network_name').notNull(),
  certResolver: text('cert_resolver'),
  entrypointHttp: text('entrypoint_http').notNull().default('web'),
  entrypointHttps: text('entrypoint_https').notNull().default('websecure'),
  /** Motifs autorisés, ex. `*.apps.interne.example`. */
  allowedDomains: text('allowed_domains').array().notNull().default(sql`'{}'::text[]`),
  defaultMiddlewares: text('default_middlewares').array().notNull().default(sql`'{}'::text[]`),
  routerNamePattern: text('router_name_pattern').notNull().default('{project}-{env}-{service}'),
  exposure: exposure('exposure').notNull().default('internal'),
  redirectToHttps: boolean('redirect_to_https').notNull().default(true),
  /**
   * Reverse proxy de l'endpoint : Traefik (labels), nginx-proxy (variables VIRTUAL_HOST… des
   * conteneurs) ou nginx classique (fichier server { } écrit dans conf.d, puis rechargement).
   */
  provider: text('provider').$type<'traefik' | 'nginx-proxy' | 'nginx'>().notNull().default('traefik'),
  /** nginx-proxy : certificats Let's Encrypt par acme-companion (LETSENCRYPT_HOST). */
  letsencrypt: boolean('letsencrypt').notNull().default(false),
  /** nginx classique : conteneur nginx, dossier des configurations, certificats ({host} remplacé). */
  nginxContainer: text('nginx_container'),
  nginxConfDir: text('nginx_conf_dir').notNull().default('/etc/nginx/conf.d'),
  nginxSslCertificate: text('nginx_ssl_certificate'),
  nginxSslCertificateKey: text('nginx_ssl_certificate_key'),
  /** nginx : dossier où la console dépose les certificats (<domaine>.crt / .key) dans le conteneur. */
  nginxCertsDir: text('nginx_certs_dir').notNull().default('/etc/nginx/platform-certs'),
  /** nginx classique : Let's Encrypt par la console (e-mail du compte ACME ; null : désactivé). */
  nginxAcmeEmail: text('nginx_acme_email'),
  /** Autorité ACME : letsencrypt, letsencrypt-staging, ou URL d'annuaire (autorité interne). */
  nginxAcmeDirectory: text('nginx_acme_directory').notNull().default('letsencrypt'),
  /** Clé du compte ACME (chiffrée). */
  nginxAcmeAccountSecretId: uuid('nginx_acme_account_secret_id').references(() => secrets.id),
  /** nginx classique : journal d'accès des sites (json : format de la console, avec domaine et durées ; default : celui de nginx ; off). */
  nginxAccessLog: text('nginx_access_log').$type<'json' | 'default' | 'off'>().notNull().default('json'),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
}, t => [unique('traefik_configs_uq').on(t.endpointId, t.environmentId).nullsNotDistinct()])

/**
 * Traefik déployé et maintenu par la plateforme sur un endpoint (stack platform-traefik) :
 * ports, réseaux, ACME. Les identifiants du fournisseur DNS sont chiffrés à part.
 */
export const managedProxies = pgTable('managed_proxies', {
  id: id(),
  endpointId: uuid('endpoint_id').notNull().unique().references(() => serverEndpoints.id, { onDelete: 'cascade' }),
  config: jsonb('config').$type<import('../../shared/schemas/managed-proxy').ManagedProxyConfig>().notNull(),
  /** Variables du fournisseur DNS (JSON chiffré : nom → valeur). */
  dnsEnvSecretId: uuid('dns_env_secret_id').references(() => secrets.id),
  status: text('status').notNull().default('draft'),
  appliedConfig: jsonb('applied_config').$type<import('../../shared/schemas/managed-proxy').ManagedProxyConfig | null>(),
  appliedAt: timestamp('applied_at', { withTimezone: true }),
  /** Certificats importés en service (identifiants et empreintes), pour signaler une application à refaire. */
  appliedCertificates: jsonb('applied_certificates').$type<string[]>().notNull().default([]),
  /** Routes vers des conteneurs externes en service (empreintes), pour signaler une application à refaire. */
  appliedRoutes: jsonb('applied_routes').$type<string[]>().notNull().default([]),
  lastError: text('last_error'),
  updatedBy: uuid('updated_by').references(() => users.id),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
})

/**
 * Routes du Traefik géré vers des conteneurs qui ne sont pas déployés par la plateforme
 * (stack lancée hors plateforme) : fournisseur fichier, conteneur rattaché au réseau du
 * proxy par la plateforme (et rattaché de nouveau s'il est recréé). Le conteneur est
 * désigné par son projet et son service Compose, stables d'une recréation à l'autre.
 */
export const proxyRoutes = pgTable('proxy_routes', {
  id: id(),
  endpointId: uuid('endpoint_id').notNull().references(() => serverEndpoints.id, { onDelete: 'cascade' }),
  /** Projet Compose (null : conteneur hors Compose, désigné par son nom). */
  stack: text('stack'),
  service: text('service'),
  containerName: text('container_name').notNull(),
  host: text('host').notNull(),
  pathPrefix: text('path_prefix'),
  port: integer('port').notNull(),
  https: boolean('https').notNull().default(true),
  /** Réseau du proxy auquel la plateforme a rattaché le conteneur (détaché à la suppression de la route). */
  network: text('network').notNull(),
  attachedByPlatform: boolean('attached_by_platform').notNull().default(false),
  createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
  createdAt: createdAt(),
}, t => [uniqueIndex('proxy_routes_host_uq').on(t.endpointId, t.host, t.pathPrefix)])

/** Dernière analyse de vulnérabilités (Trivy) de chaque image en service, par endpoint. */
export const imageScans = pgTable('image_scans', {
  id: uuid('id').primaryKey().defaultRandom(),
  endpointId: uuid('endpoint_id').notNull().references(() => serverEndpoints.id, { onDelete: 'cascade' }),
  image: text('image').notNull(),
  imageId: text('image_id').notNull(),
  scannedAt: timestamp('scanned_at', { withTimezone: true }).notNull().defaultNow(),
  status: text('status').$type<'ok' | 'error'>().notNull(),
  error: text('error'),
  os: text('os'),
  counts: jsonb('counts').$type<SeverityCounts>().notNull(),
  fixable: integer('fixable').notNull().default(0),
  /** Vulnérabilités (au plus 1 000, les plus graves d'abord). */
  findings: jsonb('findings').$type<Finding[]>().notNull().default([]),
  targets: jsonb('targets').$type<ImageScanDto['targets']>().notNull().default([]),
  /** Dépôt d'origine déclaré par l'image (label org.opencontainers.image.source). */
  sourceUrl: text('source_url'),
  /** Origine de l'analyse : déploiement (avec son identifiant), planifiée ou à la demande. */
  trigger: text('trigger').$type<'deploy' | 'planned' | 'manual'>(),
  deploymentId: uuid('deployment_id'),
  /** Version déclarée par l'image (label org.opencontainers.image.version). */
  imageVersion: text('image_version'),
  /** Analyse demandée (en file) ou en cours, et depuis quand. */
  scanState: text('scan_state').$type<'queued' | 'running' | null>(),
  scanStateAt: timestamp('scan_state_at', { withTimezone: true }),
}, t => [uniqueIndex('image_scans_endpoint_image_idx').on(t.endpointId, t.imageId)])

/**
 * Demandes de correction (issues ou PR GitHub) ouvertes depuis la page Vulnérabilités, suivies
 * jusqu'à leur résolution : état GitHub synchronisé, résolution constatée par une nouvelle analyse.
 */
export const remediationRequests = pgTable('remediation_requests', {
  id: uuid('id').primaryKey().defaultRandom(),
  kind: text('kind').$type<'issue' | 'pr'>().notNull(),
  subjectType: text('subject_type').$type<'image' | 'source'>().notNull(),
  /** Image : endpoint et référence (sans le tag de release pour une image construite par la console). */
  endpointId: uuid('endpoint_id').references(() => serverEndpoints.id, { onDelete: 'cascade' }),
  imageRef: text('image_ref'),
  /** Code source : cible dont la release active est analysée. */
  targetId: uuid('target_id').references(() => projectTargets.id, { onDelete: 'cascade' }),
  label: text('label').notNull(),
  apiUrl: text('api_url').notNull(),
  repository: text('repository').notNull(),
  number: integer('number').notNull(),
  url: text('url').notNull(),
  title: text('title').notNull(),
  /** Vulnérabilités visées : la demande est résolue quand plus aucune n'est relevée. */
  vulnIds: text('vuln_ids').array().notNull().default(sql`'{}'::text[]`),
  state: text('state').$type<'open' | 'closed' | 'merged' | 'resolved'>().notNull().default('open'),
  createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
  createdAt: createdAt(),
  lastSyncAt: timestamp('last_sync_at', { withTimezone: true }),
  closedAt: timestamp('closed_at', { withTimezone: true }),
  resolvedAt: timestamp('resolved_at', { withTimezone: true }),
}, t => [uniqueIndex('remediation_requests_issue_uq').on(t.apiUrl, t.repository, t.number)])

/** Dernière analyse des dépendances du code source (Trivy fs) de la release active de chaque cible. */
/** Webhook GitHub d'un projet : secret (chiffré) qui signe les livraisons ; un seul par projet. */
export const projectWebhooks = pgTable('project_webhooks', {
  id: id(),
  projectId: uuid('project_id').notNull().unique().references(() => projects.id, { onDelete: 'cascade' }),
  secretId: uuid('secret_id').notNull().references(() => secrets.id),
  createdAt: createdAt(),
  rotatedAt: timestamp('rotated_at', { withTimezone: true }),
  lastDeliveryAt: timestamp('last_delivery_at', { withTimezone: true }),
})

/** Livraisons reçues (signature valide) : identifiant GitHub unique par projet, résultat par cible. */
export const webhookDeliveries = pgTable('webhook_deliveries', {
  id: id(),
  projectId: uuid('project_id').notNull().references(() => projects.id, { onDelete: 'cascade' }),
  guid: text('guid').notNull(),
  event: text('event').notNull(),
  ref: text('ref'),
  sha: text('sha'),
  outcome: text('outcome').$type<import('../../shared/schemas/webhook').WebhookOutcome>().notNull().default('accepted'),
  detail: text('detail'),
  results: jsonb('results').$type<import('../../shared/schemas/webhook').WebhookTargetResult[]>().notNull().default([]),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
}, t => [uniqueIndex('webhook_deliveries_project_guid_idx').on(t.projectId, t.guid)])

/** Facteur TOTP d'un utilisateur : secret chiffré, actif une fois un premier code vérifié ; dernier pas de temps accepté (anti-rejeu). */
export const userTotp = pgTable('user_totp', {
  userId: uuid('user_id').primaryKey().references(() => users.id, { onDelete: 'cascade' }),
  secretId: uuid('secret_id').notNull().references(() => secrets.id),
  confirmedAt: timestamp('confirmed_at', { withTimezone: true }),
  lastStep: bigint('last_step', { mode: 'number' }),
  createdAt: createdAt(),
})

/** Codes de secours (usage unique) : seule leur empreinte est conservée. */
export const mfaRecoveryCodes = pgTable('mfa_recovery_codes', {
  id: id(),
  userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  codeHash: text('code_hash').notNull(),
  usedAt: timestamp('used_at', { withTimezone: true }),
  createdAt: createdAt(),
}, t => [index('mfa_recovery_user_idx').on(t.userId)])

/** Passkeys (WebAuthn) d'un utilisateur : clé publique, compteur ; sert de second facteur et de connexion sans mot de passe. */
export const userPasskeys = pgTable('user_passkeys', {
  id: id(),
  userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  credentialId: text('credential_id').notNull().unique(),
  publicKey: text('public_key').notNull(),
  counter: bigint('counter', { mode: 'number' }).notNull().default(0),
  transports: text('transports').array().notNull().default(sql`'{}'::text[]`),
  name: text('name').notNull(),
  backedUp: boolean('backed_up').notNull().default(false),
  createdAt: createdAt(),
  lastUsedAt: timestamp('last_used_at', { withTimezone: true }),
}, t => [index('user_passkeys_user_idx').on(t.userId)])

/** Jetons d'API d'un utilisateur : agissent au nom de leur propriétaire, avec moins de droits (voir lib/api-token). */
export const apiTokens = pgTable('api_tokens', {
  id: id(),
  userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  name: text('name').notNull(),
  /** Empreinte SHA-256 du jeton (forte entropie : pas de hachage lent) ; le jeton lui-même n'est jamais conservé. */
  tokenHash: text('token_hash').notNull().unique(),
  /** Début du jeton (shp_xxxxxxxx), pour le reconnaître dans la liste. */
  prefix: text('prefix').notNull(),
  permissions: text('permissions').array().notNull(),
  projectId: uuid('project_id').references(() => projects.id, { onDelete: 'cascade' }),
  environmentId: uuid('environment_id').references(() => environments.id, { onDelete: 'cascade' }),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  lastUsedAt: timestamp('last_used_at', { withTimezone: true }),
  lastUsedIp: text('last_used_ip'),
  revokedAt: timestamp('revoked_at', { withTimezone: true }),
  createdAt: createdAt(),
}, t => [index('api_tokens_user_idx').on(t.userId)])

export const sourceScans = pgTable('source_scans', {
  id: uuid('id').primaryKey().defaultRandom(),
  targetId: uuid('target_id').notNull().unique().references(() => projectTargets.id, { onDelete: 'cascade' }),
  releaseId: uuid('release_id').references(() => releases.id, { onDelete: 'set null' }),
  scannedAt: timestamp('scanned_at', { withTimezone: true }).notNull().defaultNow(),
  status: text('status').$type<'ok' | 'error'>().notNull(),
  error: text('error'),
  counts: jsonb('counts').$type<SeverityCounts>().notNull(),
  fixable: integer('fixable').notNull().default(0),
  findings: jsonb('findings').$type<Finding[]>().notNull().default([]),
  manifests: text('manifests').array().notNull().default(sql`'{}'::text[]`),
  trigger: text('trigger').$type<'deploy' | 'planned' | 'manual'>(),
  deploymentId: uuid('deployment_id'),
  scanState: text('scan_state').$type<'queued' | 'running' | null>(),
  scanStateAt: timestamp('scan_state_at', { withTimezone: true }),
})

/**
 * Connecteurs GitHub : packages (GitHub Packages) et artefacts Actions d'un compte, analysés
 * périodiquement ; dernier relevé et alertes conservés. Jeton chiffré, jamais renvoyé.
 */
export const githubConnectors = pgTable('github_connectors', {
  id: uuid('id').primaryKey().defaultRandom(),
  name: text('name').notNull().unique(),
  apiUrl: text('api_url').notNull().default('https://api.github.com'),
  owner: text('owner').notNull(),
  ownerType: text('owner_type').$type<'org' | 'user'>().notNull(),
  tokenSecretId: uuid('token_secret_id').notNull().references(() => secrets.id),
  repositories: text('repositories').array().notNull().default(sql`'{}'::text[]`),
  registryHost: text('registry_host').notNull().default('ghcr.io'),
  expiringDays: integer('expiring_days').notNull().default(7),
  enabled: boolean('enabled').notNull().default(true),
  lastScanAt: timestamp('last_scan_at', { withTimezone: true }),
  lastError: text('last_error'),
  snapshot: jsonb('snapshot').$type<GithubScanSnapshot | null>(),
  createdBy: uuid('created_by').references(() => users.id),
  createdAt: createdAt(),
})

/**
 * Comptes DNS pour le défi ACME DNS-01 (certificats génériques, domaines internes) : fournisseur,
 * zones couvertes, identifiants d'API chiffrés (jamais renvoyés). Communs à tous les serveurs.
 */
export const dnsAccounts = pgTable('dns_accounts', {
  id: uuid('id').primaryKey().defaultRandom(),
  name: text('name').notNull().unique(),
  provider: text('provider').$type<'cloudflare' | 'ovh' | 'route53'>().notNull(),
  /** Zones servies (ex. exemple.fr) : un domaine utilise le compte de la zone la plus précise. */
  zones: text('zones').array().notNull().default(sql`'{}'::text[]`),
  /** Certificats génériques : *.parent (et parent) au lieu d'un certificat par nom. */
  wildcard: boolean('wildcard').notNull().default(true),
  secretId: uuid('secret_id').notNull().references(() => secrets.id),
  lastCheckAt: timestamp('last_check_at', { withTimezone: true }),
  lastError: text('last_error'),
  createdBy: uuid('created_by').references(() => users.id),
  createdAt: createdAt(),
})

/**
 * Certificats importés pour le Traefik géré d'un endpoint (sans ACME, ou pour des
 * domaines précis). Chaîne publique en clair ; clé privée chiffrée (secrets), jamais renvoyée.
 */
export const proxyCertificates = pgTable('proxy_certificates', {
  id: id(),
  endpointId: uuid('endpoint_id').notNull().references(() => serverEndpoints.id, { onDelete: 'cascade' }),
  domains: text('domains').array().notNull(),
  subject: text('subject').notNull(),
  issuer: text('issuer').notNull(),
  notBefore: timestamp('not_before', { withTimezone: true }).notNull(),
  notAfter: timestamp('not_after', { withTimezone: true }).notNull(),
  fingerprint: text('fingerprint').notNull(),
  selfSigned: boolean('self_signed').notNull().default(false),
  keyType: text('key_type').notNull(),
  certPem: text('cert_pem').notNull(),
  keySecretId: uuid('key_secret_id').notNull().references(() => secrets.id),
  /** Servi pour les noms sans certificat (SNI inconnu). */
  isDefault: boolean('is_default').notNull().default(false),
  /** Origine : importé, ou obtenu par la console (ACME, renouvelé automatiquement). */
  source: text('source').$type<'imported' | 'acme'>().notNull().default('imported'),
  createdBy: uuid('created_by').references(() => users.id),
  createdAt: createdAt(),
}, t => [
  uniqueIndex('proxy_certificates_endpoint_fp').on(t.endpointId, t.fingerprint),
])

// ---------------------------------------------------------------------------
// Projets, sources, releases, déploiements
// ---------------------------------------------------------------------------

export const projects = pgTable('projects', {
  id: id(),
  slug: text('slug').notNull().unique(),
  name: text('name').notNull(),
  description: text('description'),
  ownerUserId: uuid('owner_user_id').references(() => users.id),
  archivedAt: timestamp('archived_at', { withTimezone: true }),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
})

export const projectSources = pgTable('project_sources', {
  id: id(),
  projectId: uuid('project_id').notNull().unique().references(() => projects.id, { onDelete: 'cascade' }),
  kind: sourceKind('kind').notNull(),
  /** API GitHub (github.com ou Enterprise), parmi celles autorisées par l'administrateur. */
  apiUrl: text('api_url').notNull().default('https://api.github.com'),
  repository: text('repository'),
  refType: gitRefType('ref_type'),
  ref: text('ref'),
  subdirectory: text('subdirectory'),
  composePath: text('compose_path').notNull().default('compose.yml'),
  dockerfilePath: text('dockerfile_path'),
  buildArgs: jsonb('build_args').$type<Record<string, string>>().notNull().default({}),
  submodules: boolean('submodules').notNull().default(false),
  tokenSecretId: uuid('token_secret_id').references(() => secrets.id),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
})

/** Cible de déploiement : un projet sur un endpoint pour un environnement. */
export const projectTargets = pgTable('project_targets', {
  id: id(),
  projectId: uuid('project_id').notNull().references(() => projects.id, { onDelete: 'cascade' }),
  endpointId: uuid('endpoint_id').notNull().references(() => serverEndpoints.id),
  environmentId: uuid('environment_id').notNull().references(() => environments.id),
  /** Surcharges appliquées au Compose source (réseaux, ports, labels...). */
  composeOverrides: jsonb('compose_overrides').$type<Partial<ComposeOverrides>>().notNull().default({}),
  /** Variables d'environnement chiffrées (JSON sérialisé dans le secret). */
  envSecretId: uuid('env_secret_id').references(() => secrets.id),
  /** Politique Watchtower par service (§12), désactivée par défaut. */
  watchtower: jsonb('watchtower').$type<WatchtowerConfig>().notNull().default({ enabled: false, services: {} } as WatchtowerConfig),
  /** Configuration Watchtower effectivement appliquée à la stack (dernier déploiement réussi). */
  watchtowerApplied: jsonb('watchtower_applied').$type<WatchtowerConfig | null>(),
  /** Image du sidecar Watchtower réellement déployée (comparée à l'image choisie par l'administration). */
  watchtowerImageApplied: text('watchtower_image_applied'),
  /** Jeton (chiffré) de l'URL de notification que Watchtower appelle après chaque passage. */
  watchtowerHookSecretId: uuid('watchtower_hook_secret_id').references(() => secrets.id),
  /** Watchtower suspendu après un échec de mise à jour (politique « pause »). */
  watchtowerPausedAt: timestamp('watchtower_paused_at', { withTimezone: true }),
  /** Images exécutées observées par service : base de détection des mises à jour hors plateforme. */
  /** Dernier constat de santé de la stack (job périodique) : base des alertes « healthcheck dégradé ». */
  healthState: jsonb('health_state').$type<TargetHealthState | null>(),
  /** Reconstruction automatique à chaque nouvelle version de la source. */
  autoRebuild: jsonb('auto_rebuild').$type<AutoRebuildState | null>(),
  /** Déploiement au push GitHub : environnement concerné, branche suivie. */
  webhook: jsonb('webhook').$type<import('../../shared/schemas/webhook').TargetWebhook | null>(),
  /** Action restant à faire pour terminer la mise en service (saisie, vérification…) ; effacée au prochain déploiement réussi. */
  pendingAction: jsonb('pending_action').$type<import('../../shared/schemas/projects').PendingAction | null>(),
  /** Date de dernière modification de chaque variable (sans valeur ni empreinte) : vérification des actions en attente. */
  variablesMeta: jsonb('variables_meta').$type<Record<string, { updatedAt: string }>>().notNull().default({}),
  observedImages: jsonb('observed_images').$type<Record<string, { image: string, imageId: string, seenAt: string }>>().notNull().default({}),
  portainerStackId: integer('portainer_stack_id'),
  stackName: text('stack_name'),
  currentReleaseId: uuid('current_release_id'),
  /** Services exposés via le Traefik de l'endpoint (§11). */
  exposures: jsonb('exposures').$type<{ service: string, host: string, port: number, pathPrefix: string | null, middlewares: string[] }[]>().notNull().default([]),
  /** Redéploie la release précédente si les healthchecks échouent. */
  /**
   * Chemin racine du projet sur l'hôte (null : <workingRoot>/<projet> et <runtimeRoot>/<projet>).
   * Contient les releases (releases/) et les données (data/).
   */
  projectPath: text('project_path'),
  /** Volumes nommés du Compose stockés en dossiers sous les données du projet. */
  volumesAsFolders: boolean('volumes_as_folders').notNull().default(false),
  /** Réseau du reverse proxy pour ce projet (null : celui de la configuration Traefik de l'endpoint). */
  proxyNetwork: text('proxy_network'),
  /**
   * Dernière migration vers un autre serveur : emplacement d'origine, où l'ancienne stack est
   * restée arrêtée (avec ses données) jusqu'à son nettoyage depuis la console.
   */
  migratedFrom: jsonb('migrated_from').$type<import('../../shared/schemas/migration').MigratedFrom | null>(),
  /** Stack reprise de l'existant (null : créée par la plateforme). */
  adoption: jsonb('adoption').$type<TargetAdoption | null>(),
  autoRollback: boolean('auto_rollback').notNull().default(true),
  healthTimeoutSec: integer('health_timeout_sec').notNull().default(120),
  createdBy: uuid('created_by').references(() => users.id),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
}, t => [uniqueIndex('project_targets_uq').on(t.projectId, t.endpointId, t.environmentId)])

/**
 * Profils Watchtower d'un endpoint : un conteneur Watchtower par profil (rythme, nettoyage),
 * partagé par les projets qui le choisissent ; les services y sont rattachés par labels (scope).
 */
export const watchtowerProfiles = pgTable('watchtower_profiles', {
  id: id(),
  endpointId: uuid('endpoint_id').notNull().references(() => serverEndpoints.id, { onDelete: 'cascade' }),
  name: text('name').notNull(),
  timing: text('timing').$type<'interval' | 'schedule'>().notNull().default('interval'),
  intervalSec: integer('interval_sec').notNull().default(86_400),
  schedule: text('schedule').notNull().default('0 0 4 * * *'),
  cleanup: boolean('cleanup').notNull().default(true),
  stopTimeoutSec: integer('stop_timeout_sec').notNull().default(30),
  /** Jeton (chiffré) de l'URL de notification du profil. */
  hookSecretId: uuid('hook_secret_id').references(() => secrets.id),
  /** Réglages, image et exclusions en service sur l'hôte (dernière application). */
  applied: jsonb('applied').$type<Record<string, unknown> | null>(),
  /** Identifiants des registres privés (JSON chiffré : [{ registry, username, password }]). */
  registriesSecretId: uuid('registries_secret_id').references(() => secrets.id),
  /** Stacks détachées de la console (projet retiré) : leurs conteneurs restent exclus du profil. */
  detachedStacks: jsonb('detached_stacks').$type<string[]>().notNull().default([]),
  appliedAt: timestamp('applied_at', { withTimezone: true }),
  createdAt: createdAt(),
}, t => [uniqueIndex('watchtower_profiles_uq').on(t.endpointId, t.name)])

/**
 * Sous-réseaux attribués aux réseaux des projets dans la plage de l'endpoint (stables d'un
 * déploiement à l'autre) : un par cible et par réseau Compose, jamais deux fois le même sur un endpoint.
 */
export const networkAllocations = pgTable('network_allocations', {
  id: id(),
  endpointId: uuid('endpoint_id').notNull().references(() => serverEndpoints.id, { onDelete: 'cascade' }),
  targetId: uuid('target_id').notNull().references(() => projectTargets.id, { onDelete: 'cascade' }),
  /** Clé du réseau dans le Compose (default pour le réseau implicite). */
  network: text('network').notNull(),
  subnet: text('subnet').notNull(),
  /** Fixé à la main (plan d'adressage) : jamais libéré automatiquement. */
  pinned: boolean('pinned').notNull().default(false),
  createdAt: createdAt(),
}, t => [
  uniqueIndex('network_allocations_target_uq').on(t.targetId, t.network),
  uniqueIndex('network_allocations_subnet_uq').on(t.endpointId, t.subnet),
])

/** Archive déposée sur la plateforme en attente de transfert vers le serveur cible. */
export const uploads = pgTable('uploads', {
  id: id(),
  /** Chemin local sous UPLOAD_DIR (jamais fourni par l'utilisateur). */
  storagePath: text('storage_path').notNull(),
  originalName: text('original_name').notNull(),
  sizeBytes: bigint('size_bytes', { mode: 'number' }).notNull(),
  sha256: text('sha256').notNull(),
  report: jsonb('report').notNull().default({}),
  uploadedBy: uuid('uploaded_by').references(() => users.id),
  createdAt: createdAt(),
  consumedAt: timestamp('consumed_at', { withTimezone: true }),
})

export const releases = pgTable('releases', {
  id: id(),
  targetId: uuid('target_id').notNull().references(() => projectTargets.id, { onDelete: 'cascade' }),
  number: integer('number').notNull(),
  sourceKind: sourceKind('source_kind').notNull(),
  /** Commit réellement utilisé (§7.1). */
  commitSha: text('commit_sha'),
  /** Référence demandée (branche, tag ou commit) ayant conduit à ce commit. */
  sourceRef: text('source_ref'),
  repository: text('repository'),
  archiveSha256: text('archive_sha256'),
  uploadId: uuid('upload_id').references(() => uploads.id, { onDelete: 'set null' }),
  /** Identifiant utilisé dans les chemins (`r-0001-ab12cd`). */
  slug: text('slug'),
  sourceTreeSha256: text('source_tree_sha256'),
  /** Chemin du fichier Compose dans les sources. */
  composePath: text('compose_path'),
  composeSource: text('compose_source'),
  composeFinal: text('compose_final'),
  composeDiff: text('compose_diff'),
  /** Résultat de l'analyse validée par l'utilisateur (ports, volumes, réseaux, modifications, approbations). */
  analysis: jsonb('analysis').notNull().default({}),
  images: jsonb('images').$type<Record<string, string>>().notNull().default({}),
  remotePath: text('remote_path'),
  metadata: jsonb('metadata').notNull().default({}),
  createdBy: uuid('created_by').references(() => users.id),
  createdAt: createdAt(),
  activatedAt: timestamp('activated_at', { withTimezone: true }),
  purgedAt: timestamp('purged_at', { withTimezone: true }),
}, t => [uniqueIndex('releases_number_uq').on(t.targetId, t.number)])

export interface DeploymentOptions {
  /** Déploiement GitHub (API Deployments) créé pour ce déploiement : son statut y est publié. */
  githubDeployment?: { apiUrl: string, repository: string, id: number, environmentUrl?: string }
  /** Redéploiement sans récupérer à nouveau les images des registres (suspension ou reprise d'un service). */
  noPull?: boolean
  /** Exécution planifiée (le job est différé jusque-là). */
  schedule?: { at: string }
  /** Demande hors fenêtre de déploiement, soumise à validation. */
  urgent?: boolean
  /** Validation par une autre personne : en attente (aucun job), validée ou refusée. */
  approval?: { state: 'pending' | 'approved' | 'rejected', reason: 'policy' | 'urgent', requestedAt: string, decidedBy?: string | null, decidedAt?: string, comment?: string | null }
  cleanBuild?: boolean
  /** Relance sans reconstruction : images construites de la release reprises si encore présentes sur l'hôte. */
  skipBuild?: boolean
  /** Suppression définitive du projet : retiré de la plateforme une fois toutes ses stacks supprimées. */
  deleteProject?: boolean
  upgrade?: {
    services: { service: string, from: string, to: string }[]
    /** Surcharges d'images et Compose final avant la mise à niveau (restaurés en cas d'échec). */
    previousImages: Record<string, { image: string, from: string, at: string, by: string | null }>
    previousComposeFinal: string | null
    previousReleaseImages: Record<string, string>
    /** Données PostgreSQL migrées avant l'opération (restaurées en cas d'échec). */
    previousPgData?: ComposeOverrides['pgData']
    /**
     * Sauvegarde à froid des volumes des services à données, prise avant le déploiement
     * (dir : répertoire de l'hôte, renseigné une fois la copie faite) et restaurée au retour.
     */
    backup?: { dir?: string, services: { service: string, mounts: { source: string, destination: string }[] }[] }
  }
  /** Migration de la stack vers un autre serveur géré (éléments de données retenus au plan). */
  migration?: import('../../shared/schemas/migration').MigrationJobOptions
  /** Migration de PostgreSQL vers une nouvelle version majeure, avant le redéploiement. */
  pgMigration?: {
    service: string
    fromImage: string
    toImage: string
    targetMajor: number
    /** Source du montage des données sur l'hôte (volume nommé ou chemin) et sa destination. */
    mountSource: string
    mountPath: string
    oldPgdata: string
    newPgdata: string
    user: string
  }
}

export const deployments = pgTable('deployments', {
  id: id(),
  targetId: uuid('target_id').notNull().references(() => projectTargets.id, { onDelete: 'cascade' }),
  releaseId: uuid('release_id').references(() => releases.id),
  action: deploymentAction('action').notNull(),
  status: deploymentStatus('status').notNull().default('DRAFT'),
  /** Garantit l'idempotence : un même ordre ne crée qu'un job. */
  idempotencyKey: text('idempotency_key').notNull().unique(),
  jobId: text('job_id'),
  attempt: integer('attempt').notNull().default(0),
  requestedBy: uuid('requested_by').references(() => users.id),
  queuedAt: timestamp('queued_at', { withTimezone: true }),
  startedAt: timestamp('started_at', { withTimezone: true }),
  finishedAt: timestamp('finished_at', { withTimezone: true }),
  error: text('error'),
  /** Statut atteint au moment de l'échec (BUILDING : échec de build). */
  failedFrom: deploymentStatus('failed_from'),
  /** Échec pris en compte par un utilisateur : retiré du tableau de bord (reste dans l'historique). */
  acknowledgedAt: timestamp('acknowledged_at', { withTimezone: true }),
  acknowledgedBy: uuid('acknowledged_by').references(() => users.id, { onDelete: 'set null' }),
  /**
   * Options de l'opération : build propre (images de base récupérées, sans cache) et, pour
   * une mise à niveau d'images, l'état précédent à restaurer si elle échoue.
   */
  options: jsonb('options').$type<DeploymentOptions>().notNull().default({}),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
}, t => [
  index('deployments_target_idx').on(t.targetId, t.createdAt),
  index('deployments_status_idx').on(t.status),
])

/**
 * Changements d'image d'un service (§12) : mise à jour faite par Watchtower,
 * nouvelle image signalée (détection seule), échec, ou changement d'origine inconnue.
 */
export const imageUpdates = pgTable('image_updates', {
  id: id(),
  targetId: uuid('target_id').notNull().references(() => projectTargets.id, { onDelete: 'cascade' }),
  service: text('service').notNull(),
  image: text('image').notNull(),
  kind: imageUpdateKind('kind').notNull(),
  fromImageId: text('from_image_id'),
  toImageId: text('to_image_id'),
  /** Empreinte du registre (repo@sha256:…) de la nouvelle image, si connue. */
  digest: text('digest'),
  /** Release active au moment du changement. */
  releaseId: uuid('release_id').references(() => releases.id, { onDelete: 'set null' }),
  detail: text('detail'),
  detectedAt: timestamp('detected_at', { withTimezone: true, precision: 3 }).notNull().defaultNow(),
}, t => [index('image_updates_target_idx').on(t.targetId, t.detectedAt)])

/** Logs de déploiement (validation, extraction, build, Portainer, services). Rétention 6 mois. */
export const deploymentLogs = pgTable('deployment_logs', {
  id: bigserial('id', { mode: 'bigint' }).primaryKey(),
  deploymentId: uuid('deployment_id').notNull().references(() => deployments.id, { onDelete: 'cascade' }),
  ts: timestamp('ts', { withTimezone: true, precision: 3 }).notNull().defaultNow(),
  phase: logPhase('phase').notNull(),
  level: logLevel('level').notNull().default('info'),
  service: text('service'),
  /** Toujours masqué (redact) avant insertion. */
  message: text('message').notNull(),
}, t => [
  index('deployment_logs_deployment_idx').on(t.deploymentId, t.id),
  index('deployment_logs_ts_idx').on(t.ts),
])

// ---------------------------------------------------------------------------
// Audit, notifications, préférences
// ---------------------------------------------------------------------------

export const auditEvents = pgTable('audit_events', {
  id: bigserial('id', { mode: 'bigint' }).primaryKey(),
  ts: timestamp('ts', { withTimezone: true, precision: 3 }).notNull().defaultNow(),
  actorUserId: uuid('actor_user_id').references(() => users.id, { onDelete: 'set null' }),
  /** Libellé figé de l'acteur (email, « system », « watchtower »). */
  actorLabel: text('actor_label').notNull(),
  action: text('action').notNull(),
  targetType: text('target_type'),
  targetId: text('target_id'),
  serverId: uuid('server_id'),
  environmentId: uuid('environment_id'),
  projectId: uuid('project_id'),
  outcome: auditOutcome('outcome').notNull(),
  ip: text('ip'),
  details: jsonb('details').notNull().default({}),
}, t => [
  index('audit_events_ts_idx').on(t.ts),
  index('audit_events_actor_idx').on(t.actorUserId, t.ts),
  index('audit_events_target_idx').on(t.targetType, t.targetId),
])

export const notificationChannels = pgTable('notification_channels', {
  id: id(),
  kind: notificationKind('kind').notNull(),
  name: text('name').notNull(),
  /** Adresse(s), URL de webhook ou identifiants Graph : chiffré. */
  configSecretId: uuid('config_secret_id').notNull().references(() => secrets.id),
  events: text('events').array().notNull(),
  environmentIds: uuid('environment_ids').array().notNull().default(sql`'{}'::uuid[]`),
  enabled: boolean('enabled').notNull().default(true),
  /** Mode résumé : off (immédiat), daily ou weekly (lundi), à `digest_hour` heure de Paris. */
  digest: text('digest').notNull().default('off'),
  digestHour: integer('digest_hour').notNull().default(8),
  lastDigestAt: timestamp('last_digest_at', { withTimezone: true }),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
})

/**
 * Évènements de notification (§18) : émis par le moteur quels que soient les canaux,
 * ils alimentent aussi les « dernières alertes » du tableau de bord.
 */
export const notificationEvents = pgTable('notification_events', {
  id: id(),
  event: text('event').notNull(),
  severity: text('severity').notNull(),
  title: text('title').notNull(),
  /** Texte déjà masqué. */
  summary: text('summary').notNull(),
  facts: jsonb('facts').$type<{ label: string, value: string }[]>().notNull().default([]),
  link: text('link'),
  serverId: uuid('server_id'),
  environmentId: uuid('environment_id'),
  projectId: uuid('project_id'),
  createdAt: createdAt(),
}, t => [index('notification_events_created_idx').on(t.createdAt)])

/** Envoi d'un évènement sur un canal : statut, tentatives, dernière erreur. */
export const notificationDeliveries = pgTable('notification_deliveries', {
  id: id(),
  eventId: uuid('event_id').notNull().references(() => notificationEvents.id, { onDelete: 'cascade' }),
  channelId: uuid('channel_id').references(() => notificationChannels.id, { onDelete: 'set null' }),
  channelName: text('channel_name').notNull(),
  kind: notificationKind('kind').notNull(),
  status: text('status').notNull().default('pending'),
  attempts: integer('attempts').notNull().default(0),
  error: text('error'),
  createdAt: createdAt(),
  sentAt: timestamp('sent_at', { withTimezone: true }),
}, t => [index('notification_deliveries_created_idx').on(t.createdAt), index('notification_deliveries_event_idx').on(t.eventId)])

/** Réglages applicatifs persistants (ex. progression de l'assistant d'initialisation). */
export const appSettings = pgTable('app_settings', {
  key: text('key').primaryKey(),
  value: jsonb('value').notNull(),
  updatedBy: uuid('updated_by').references(() => users.id, { onDelete: 'set null' }),
  updatedAt: updatedAt(),
})

/** Vues sauvegardées des tableaux (§17). */
export const savedViews = pgTable('saved_views', {
  id: id(),
  userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  tableKey: text('table_key').notNull(),
  name: text('name').notNull(),
  state: jsonb('state').notNull(),
  createdAt: createdAt(),
}, t => [uniqueIndex('saved_views_uq').on(t.userId, t.tableKey, t.name)])

/** Modèles de Compose de la plateforme (en plus de ceux fournis) : variables déduites des références `${NOM}`. */
export const composeTemplates = pgTable('compose_templates', {
  id: id(),
  name: text('name').notNull(),
  description: text('description').notNull().default(''),
  compose: text('compose').notNull(),
  variables: jsonb('variables').$type<import('../../shared/schemas/templates').TemplateVariable[]>().notNull().default([]),
  createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
  createdAt: createdAt(),
}, t => [uniqueIndex('compose_templates_name_idx').on(sql`lower(${t.name})`)])

/** Relevés de ressources des conteneurs déployés par la plateforme (un par minute) ; purgés après METRICS_RETENTION_DAYS. */
export const containerMetrics = pgTable('container_metrics', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  ts: timestamp('ts', { withTimezone: true }).notNull().defaultNow(),
  endpointId: uuid('endpoint_id').notNull().references(() => serverEndpoints.id, { onDelete: 'cascade' }),
  /** Nom du conteneur : stable d'un déploiement à l'autre (l'identifiant change à chaque recréation). */
  container: text('container').notNull(),
  cpuPercent: real('cpu_percent'),
  memoryBytes: bigint('memory_bytes', { mode: 'number' }),
  memoryLimitBytes: bigint('memory_limit_bytes', { mode: 'number' }),
  restartCount: integer('restart_count'),
}, t => [index('container_metrics_lookup_idx').on(t.endpointId, t.container, t.ts), index('container_metrics_ts_idx').on(t.ts)])

/** Alertes de ressources : une ligne par franchissement de seuil, close au retour à la normale. */
export const metricAlerts = pgTable('metric_alerts', {
  id: id(),
  endpointId: uuid('endpoint_id').notNull().references(() => serverEndpoints.id, { onDelete: 'cascade' }),
  container: text('container').notNull(),
  ruleId: text('rule_id').notNull(),
  ruleName: text('rule_name').notNull(),
  metric: text('metric').notNull(),
  threshold: real('threshold').notNull(),
  value: real('value'),
  projectId: uuid('project_id').references(() => projects.id, { onDelete: 'set null' }),
  environmentId: uuid('environment_id').references(() => environments.id, { onDelete: 'set null' }),
  since: timestamp('since', { withTimezone: true }).notNull().defaultNow(),
  resolvedAt: timestamp('resolved_at', { withTimezone: true }),
}, t => [uniqueIndex('metric_alerts_active_idx').on(t.endpointId, t.container, t.ruleId).where(sql`resolved_at is null`)])

/** Politique de déploiement d'un environnement : validation par une autre personne et fenêtres de déploiement. */
export const environmentPolicies = pgTable('environment_policies', {
  environmentId: uuid('environment_id').primaryKey().references(() => environments.id, { onDelete: 'cascade' }),
  requireApproval: boolean('require_approval').notNull().default(false),
  timezone: text('timezone').notNull().default('Europe/Paris'),
  windows: jsonb('windows').$type<import('../../shared/utils/deploy-windows').DeployWindow[]>().notNull().default([]),
  updatedBy: uuid('updated_by').references(() => users.id, { onDelete: 'set null' }),
  updatedAt: updatedAt(),
})
