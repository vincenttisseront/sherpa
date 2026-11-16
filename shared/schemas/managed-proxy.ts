/**
 * Traefik déployé et maintenu par la plateforme sur un endpoint : ports et
 * adresse d'écoute, réseaux, certificats ACME (Let's Encrypt ou autre CA ACME).
 * Les identifiants du fournisseur DNS sont des secrets : seuls leurs noms
 * sortent de la plateforme.
 */
import { z } from 'zod'

export const MANAGED_PROXY_STACK = 'platform-traefik'
export const MANAGED_RESOLVER = 'le'
export const DEFAULT_TRAEFIK_IMAGE = 'traefik:v3.6'

const networkName = z.string().trim().regex(/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,62}$/, 'Nom de réseau invalide')
const envName = z.string().trim().regex(/^[A-Z][A-Z0-9_]{0,99}$/, 'Nom de variable invalide (MAJUSCULES, chiffres, _)')

/** Domaines réservés ou sans suffixe public : refusés par Let's Encrypt pour l'adresse de contact. */
export const RESERVED_TLD = /@(?:[^@]+\.)?(?:test|local|localhost|example|invalid|internal|lan|home|corp|intranet)$|@[^@.]+$|@example\.(?:com|net|org)$/i

export const managedProxyConfig = z.object({
  image: z.string().trim().regex(/^traefik:v3\.\d+(?:\.\d+)?$/, 'Image Traefik v3 attendue (ex. traefik:v3.6)').default(DEFAULT_TRAEFIK_IMAGE),
  /** Adresse d'écoute sur l'hôte : 0.0.0.0 (toutes interfaces) ou une IPv4 précise. */
  bindAddress: z.string().trim().regex(/^(?:\d{1,3}\.){3}\d{1,3}$/, 'Adresse IPv4 attendue').default('0.0.0.0'),
  httpPort: z.number().int().min(1).max(65535).default(80),
  httpsPort: z.number().int().min(1).max(65535).default(443),
  /** Réseaux partagés avec les projets ; le premier est celui par défaut. Créés s'ils n'existent pas. */
  networks: z.array(networkName).min(1, 'Au moins un réseau').max(10),
  redirectToHttps: z.boolean().default(true),
  /** Ne router que les conteneurs déployés par la plateforme (label platform.managed). */
  onlyManaged: z.boolean().default(true),
  logLevel: z.enum(['ERROR', 'WARN', 'INFO', 'DEBUG']).default('INFO'),
  acme: z.object({
    enabled: z.boolean().default(false),
    email: z.email('Adresse e-mail invalide').nullable().default(null),
    challenge: z.enum(['http', 'tls', 'dns']).default('http'),
    /** Fournisseur DNS (code lego, ex. ovh, cloudflare, route53). */
    dnsProvider: z.string().trim().regex(/^[a-z0-9]{2,40}$/, 'Code de fournisseur invalide (ex. ovh, cloudflare)').nullable().default(null),
    /** Autorité de test (certificats non reconnus, sans quota). */
    staging: z.boolean().default(true),
    /** Autre autorité ACME (URL du répertoire) ; vide : Let's Encrypt. */
    caServer: z.url({ protocol: /^https$/ }).nullable().default(null),
  }).default({ enabled: false, email: null, challenge: 'http', dnsProvider: null, staging: true, caServer: null }),
}).superRefine((c, ctx) => {
  if (c.httpPort === c.httpsPort) ctx.addIssue({ code: 'custom', path: ['httpsPort'], message: 'Ports HTTP et HTTPS identiques' })
  if (new Set(c.networks).size !== c.networks.length) ctx.addIssue({ code: 'custom', path: ['networks'], message: 'Réseau en double' })
  if (c.acme.enabled && !c.acme.email) ctx.addIssue({ code: 'custom', path: ['acme', 'email'], message: 'E-mail requis pour ACME' })
  // Let's Encrypt refuse les domaines réservés (« contact email has invalid domain ») ; une autre autorité peut les accepter.
  if (c.acme.enabled && c.acme.email && !c.acme.caServer && RESERVED_TLD.test(c.acme.email)) ctx.addIssue({ code: 'custom', path: ['acme', 'email'], message: 'Domaine réservé (.test, .local, .localhost, .example, .invalid…) : Let\'s Encrypt refuse ce compte, une adresse réelle est requise' })
  if (c.acme.enabled && c.acme.challenge === 'dns' && !c.acme.dnsProvider) ctx.addIssue({ code: 'custom', path: ['acme', 'dnsProvider'], message: 'Fournisseur DNS requis' })
})
export type ManagedProxyConfig = z.infer<typeof managedProxyConfig>

export const managedProxyInput = z.object({
  config: managedProxyConfig,
  /** Variables du fournisseur DNS ; valeur absente : inchangée (jamais renvoyée). */
  dnsEnv: z.array(z.object({ name: envName, value: z.string().min(1).max(4096).nullable().default(null) })).max(20).default([]),
})
export type ManagedProxyInput = z.infer<typeof managedProxyInput>

export interface ManagedProxyDto {
  config: ManagedProxyConfig | null
  dnsEnvNames: string[]
  status: 'none' | 'draft' | 'applied' | 'failed'
  /** Configuration enregistrée différente de celle appliquée. */
  pending: boolean
  appliedAt: string | null
  lastError: string | null
}

export interface ManagedProxyPreview {
  composeText: string
  /** Réseaux à créer sur l'hôte. */
  networksToCreate: string[]
  /** Conflits bloquants (ports déjà publiés par un autre conteneur). */
  conflicts: string[]
  warnings: string[]
}

export type DomainAcmeStateDto = 'valid' | 'expiring' | 'expired' | 'error' | 'pending'

export interface AcmeDomainStatus {
  host: string
  /** Projet qui expose le domaine. */
  project: string | null
  state: DomainAcmeStateDto
  issuer: string | null
  notAfter: string | null
  staging: boolean
  error: string | null
  /** Certificat importé (prioritaire sur ACME pour ce domaine) ou obtenu par ACME. */
  source?: 'acme' | 'imported'
}

export interface AcmeStatusDto {
  checkedAt: string
  /** ACME désactivé ou Traefik géré non déployé : rien à suivre. */
  enabled: boolean
  running: boolean
  account: 'registered' | 'not_registered' | 'unknown'
  /** Erreur la plus récente sans domaine précis (enregistrement du compte, autorité injoignable…). */
  generalError: string | null
  domains: AcmeDomainStatus[]
  /** Certificats présents pour des domaines qui ne sont plus exposés. */
  orphanCertificates: number
}

/** Certificat importé pour le Traefik géré (jamais la clé). */
export interface ProxyCertificateDto {
  id: string
  domains: string[]
  subject: string
  issuer: string
  notBefore: string
  notAfter: string
  fingerprint: string
  selfSigned: boolean
  keyType: string
  isDefault: boolean
  createdAt: string
  state: 'valid' | 'expiring' | 'expired'
  /** Domaines exposés par les projets de l'endpoint et couverts par ce certificat. */
  covers: string[]
  /** Pas encore en service : appliquer le Traefik géré. */
  pendingApply: boolean
  /** Importé, ou obtenu par la console (Let's Encrypt pour nginx, renouvelé automatiquement). */
  source: 'imported' | 'acme'
}

export const certificateImportInput = z.object({
  certPem: z.string().min(50, 'Certificat PEM requis').max(64 * 1024),
  keyPem: z.string().min(50, 'Clé privée PEM requise').max(64 * 1024),
  isDefault: z.boolean().default(false),
})
