import { z } from 'zod'
import { tableQuery } from './common'
import type { EnvironmentDto } from './environments'
import { wizardEndpointInput } from './infra'
import { trimTrailingSlashes } from '../utils/trim'

export const HOST_TRANSPORTS = ['agent', 'ssh'] as const
export type HostTransport = (typeof HOST_TRANSPORTS)[number]

/** Empreinte OpenSSH d'une clé d'hôte (SHA-256, base64 sans remplissage). */
export const SSH_FINGERPRINT_RE = /^SHA256:[A-Za-z0-9+/]{43}$/
/** Nom d'hôte DNS ou adresse IPv4/IPv6. */
const SSH_HOST_RE = /^(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)*|\d{1,3}(?:\.\d{1,3}){3}|[0-9A-Fa-f:]{2,39})$/

const sshHost = z.string().trim().regex(SSH_HOST_RE, 'Nom d\'hôte ou adresse IP attendu').max(253)
const sshPort = z.coerce.number().int().min(1).max(65_535).default(22)

/** Agent Portainer : adresse et AGENT_SECRET. */
const agentConnectionInput = z.object({
  transport: z.literal('agent'),
  url: z.url({ protocol: /^https?$/ }).transform(u => trimTrailingSlashes(u)),
  token: z.string().min(10).max(512),
  tlsVerify: z.boolean().default(true),
  caCertPem: z.string().max(20_000).optional(),
})

/** Identifiants SSH : mot de passe, ou clé privée (phrase de passe facultative). Jamais renvoyés. */
export const sshCredentialsInput = z.object({
  auth: z.enum(['password', 'key']),
  password: z.string().min(1).max(1024).optional(),
  privateKey: z.string().max(20_000).optional(),
  passphrase: z.string().max(1024).optional(),
}).superRefine((v, ctx) => {
  if (v.auth === 'password' && !v.password) ctx.addIssue({ code: 'custom', path: ['password'], message: 'Mot de passe requis' })
  if (v.auth === 'key' && !/-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(v.privateKey ?? '')) ctx.addIssue({ code: 'custom', path: ['privateKey'], message: 'Clé privée PEM ou OpenSSH attendue (-----BEGIN … PRIVATE KEY-----)' })
})
export type SshCredentialsInput = z.infer<typeof sshCredentialsInput>

/** SSH : hôte, utilisateur, identifiants et empreinte de la clé d'hôte confirmée. */
const sshConnectionInput = z.object({
  transport: z.literal('ssh'),
  host: sshHost,
  port: sshPort,
  username: z.string().trim().regex(/^[A-Za-z_][A-Za-z0-9_.-]{0,31}$/, 'Nom d\'utilisateur Unix attendu'),
  hostKey: z.string().regex(SSH_FINGERPRINT_RE, 'Empreinte de clé d\'hôte à confirmer (SHA256:…)'),
  dockerSocket: z.string().regex(/^\/[A-Za-z0-9._/-]{1,255}$/, 'Chemin absolu du socket Docker attendu').default('/var/run/docker.sock'),
}).and(sshCredentialsInput)

/** Données saisies dans le wizard de connexion (§5.1). Aucun secret n'est jamais renvoyé. */
export const serverConnectionInput = z.preprocess(
  // Sans transport : agent Portainer (clients existants).
  v => (v && typeof v === 'object' && !('transport' in v) ? { ...v, transport: 'agent' } : v),
  z.union([agentConnectionInput, sshConnectionInput]),
)
export type ServerConnectionInput = z.infer<typeof serverConnectionInput>

const serverMeta = z.object({
  name: z.string().trim().min(2).max(100),
  description: z.string().trim().max(1000).optional(),
  tags: z.array(z.string().trim().min(1).max(50)).max(20).default([]),
})

export const serverCreateInput = serverConnectionInput.and(serverMeta)
export type ServerCreateInput = z.infer<typeof serverCreateInput>

/** Lecture de la clé d'hôte avant confirmation (aucune authentification). */
export const sshHostKeyScanInput = z.object({ host: sshHost, port: sshPort })
export interface SshHostKeyScan { fingerprint: string, keyType: string }

export const serverListQuery = tableQuery.extend({
  status: z.enum(['unknown', 'online', 'degraded', 'offline']).optional(),
})

export const SERVER_STATUSES = ['unknown', 'online', 'degraded', 'offline'] as const
export type ServerStatus = (typeof SERVER_STATUSES)[number]

/** Représentation publique d'un serveur : aucune donnée secrète. */
export interface ServerDto {
  id: string
  name: string
  description: string | null
  /** Agent Portainer, ou SSH (sans agent ni Runner). */
  transport: HostTransport
  /** Agent : https://hôte:9001 ; SSH : ssh://utilisateur@hôte:port. */
  url: string
  tlsVerify: boolean
  detectedVersion: string | null
  status: ServerStatus
  tags: string[]
  endpointCount: number
  lastCheckedAt: string | null
  lastError: string | null
  createdAt: string
}

export interface ConnectionTestResult {
  ok: boolean
  version: string | null
  supported: boolean
  endpoints: { id: number, name: string, type: string }[]
  error?: string
  durationMs: number
}

/** Charge utile finale de l'assistant : tout est créé dans une seule transaction. */
export const serverWizardInput = serverCreateInput.and(z.object({
  endpoints: z.array(wizardEndpointInput).min(1, 'Au moins un endpoint doit être retenu'),
})).refine(w => w.endpoints.some(e => e.enabled), { message: 'Au moins un endpoint doit être activé', path: ['endpoints'] })
export type ServerWizardInput = z.infer<typeof serverWizardInput>

export const serverPatch = z.object({
  name: z.string().trim().min(2).max(100).optional(),
  description: z.string().trim().max(1000).nullable().optional(),
  tags: z.array(z.string().trim().min(1).max(50)).max(20).optional(),
  url: z.url({ protocol: /^https?$/ }).transform(u => trimTrailingSlashes(u)).optional(),
  tlsVerify: z.boolean().optional(),
  caCertPem: z.string().max(20_000).nullable().optional(),
  /** Hôte SSH : changement re-testé avec les identifiants enregistrés ; nouvel hôte ou port : empreinte à confirmer. */
  sshHost: sshHost.optional(),
  sshPort: z.coerce.number().int().min(1).max(65_535).optional(),
  sshUser: z.string().trim().regex(/^[A-Za-z_][A-Za-z0-9_.-]{0,31}$/, 'Nom d\'utilisateur Unix attendu').optional(),
  sshHostKey: z.string().regex(SSH_FINGERPRINT_RE).optional(),
  dockerSocket: z.string().regex(/^\/[A-Za-z0-9._/-]{1,255}$/, 'Chemin absolu du socket Docker attendu').optional(),
})

export const tokenRotation = z.object({ token: z.string().min(10).max(512) })
/** Remplacement des identifiants SSH (mot de passe ou clé). */
export const sshCredentialsRotation = sshCredentialsInput
/** Nouvelle empreinte de clé d'hôte, confirmée après lecture (hôte réinstallé, clé régénérée). */
export const sshHostKeyConfirm = z.object({ hostKey: z.string().regex(SSH_FINGERPRINT_RE, 'Empreinte SHA256:… attendue') })

export interface EndpointDto {
  id: string
  portainerEndpointId: number
  name: string
  type: string
  url: string | null
  online: boolean
  enabled: boolean
  missing: boolean
  environments: EnvironmentDto[]
  inventory: { containers: number, running: number, images: number, stacks: number, traefik: { container: string, image: string, networks: string[] } | null, proxies?: { kind: string, container: string, image: string }[], composeProjects?: number }
  discoveredAt: string
  networkCount: number
  unreviewedNetworks: number
  volumeCount: number
}

/** Paramètres SSH publics (aucun secret). */
export interface ServerSshDto {
  host: string
  port: number
  username: string
  auth: 'password' | 'key' | null
  hostKey: string | null
  hostKeyType: string | null
  dockerSocket: string
}

export interface ServerDetailDto extends ServerDto {
  caCertPem: string | null
  ssh: ServerSshDto | null
  capabilities: Record<string, boolean>
  lastDiscoveryAt: string | null
  updatedAt: string
  endpoints: EndpointDto[]
}

export interface NetworkDto {
  id: string
  name: string
  driver: string | null
  scope: string | null
  internal: boolean
  labels: Record<string, string>
  policy: 'unreviewed' | 'allowed' | 'forbidden'
  role: 'none' | 'traefik' | 'app'
  external: boolean
  description: string | null
  tags: string[]
  allowedEnvironmentKeys: string[]
  missing: boolean
  discoveredAt: string
}

export interface VolumeDto {
  id: string
  name: string
  driver: string | null
  mountpoint: string | null
  labels: Record<string, string>
  missing: boolean
  discoveredAt: string
}

export interface DiscoveryReport {
  endpoints: { added: number, updated: number, missing: number }
  networks: { added: number, updated: number, missing: number }
  volumes: { added: number, updated: number, missing: number }
  errors: { endpoint: string, error: string }[]
}
