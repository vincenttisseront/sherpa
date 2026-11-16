/**
 * Comptes DNS du défi ACME DNS-01 : fournisseurs pris en charge, identifiants par fournisseur
 * (écrits seulement, jamais relus), zones couvertes.
 */
import { z } from 'zod'
import { DOMAIN_PATTERN_RE } from './infra'

export const DNS_PROVIDERS = ['cloudflare', 'ovh', 'route53'] as const
export type DnsProvider = (typeof DNS_PROVIDERS)[number]
export const DNS_PROVIDER_LABEL: Record<DnsProvider, string> = { cloudflare: 'Cloudflare', ovh: 'OVHcloud', route53: 'AWS Route 53' }

export const OVH_ENDPOINTS = { 'ovh-eu': 'https://eu.api.ovh.com/1.0', 'ovh-ca': 'https://ca.api.ovh.com/1.0', 'ovh-us': 'https://api.us.ovhcloud.com/1.0' } as const

const secret = (label: string) => z.string().trim().min(8, `${label} requis`).max(2000)

export const dnsCredentials = z.discriminatedUnion('provider', [
  z.object({ provider: z.literal('cloudflare'), apiToken: secret('Jeton d\'API') }),
  z.object({
    provider: z.literal('ovh'),
    endpoint: z.enum(Object.keys(OVH_ENDPOINTS) as [keyof typeof OVH_ENDPOINTS]).default('ovh-eu'),
    applicationKey: secret('Application key'),
    applicationSecret: secret('Application secret'),
    consumerKey: secret('Consumer key'),
  }),
  z.object({
    provider: z.literal('route53'),
    accessKeyId: z.string().trim().regex(/^[A-Z0-9]{16,128}$/, 'Access key ID invalide'),
    secretAccessKey: secret('Secret access key'),
  }),
])
export type DnsCredentials = z.infer<typeof dnsCredentials>

const zone = z.string().trim().toLowerCase().refine(v => !v.startsWith('*') && DOMAIN_PATTERN_RE.test(v), 'Zone invalide (ex. exemple.fr)')

export const dnsAccountInput = z.object({
  name: z.string().trim().min(1, 'Nom requis').max(100),
  zones: z.array(zone).max(200).default([]),
  wildcard: z.boolean().default(true),
  credentials: dnsCredentials,
})
export type DnsAccountInput = z.infer<typeof dnsAccountInput>

/** Modification : identifiants absents = conservés. */
export const dnsAccountPatch = z.object({
  name: z.string().trim().min(1).max(100).optional(),
  zones: z.array(zone).max(200).optional(),
  wildcard: z.boolean().optional(),
  credentials: dnsCredentials.optional(),
})

export interface DnsAccountDto {
  id: string
  name: string
  provider: DnsProvider
  zones: string[]
  wildcard: boolean
  lastCheckAt: string | null
  lastError: string | null
  createdAt: string
}

export interface DnsCheckResult { ok: boolean, zones: string[], error: string | null }
