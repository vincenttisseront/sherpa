/**
 * Comptes DNS (défi ACME DNS-01) : identifiants chiffrés, jamais renvoyés ; contrôle de l'accès
 * à l'API (zones visibles) ; choix du compte d'un domaine (zone la plus précise).
 */
import { eq } from 'drizzle-orm'
import { createError } from 'h3'
import { type DnsAccountDto, type DnsAccountInput, type DnsCheckResult, type DnsCredentials, dnsCredentials } from '../../shared/schemas/dns'
import { db, schema } from '../db/client'
import { type DnsApi, dnsApi } from '../lib/dns/providers'
import { decryptSecret, encryptSecret } from '../utils/crypto'
import { env } from '../utils/env'

type Row = typeof schema.dnsAccounts.$inferSelect

const toDto = (r: Row): DnsAccountDto => ({
  id: r.id,
  name: r.name,
  provider: r.provider,
  zones: r.zones,
  wildcard: r.wildcard,
  lastCheckAt: r.lastCheckAt?.toISOString() ?? null,
  lastError: r.lastError,
  createdAt: r.createdAt.toISOString(),
})

export async function listDnsAccounts(): Promise<DnsAccountDto[]> {
  return (await db().select().from(schema.dnsAccounts)).map(toDto).sort((a, b) => a.name.localeCompare(b.name))
}

async function rowOr404(id: string): Promise<Row> {
  const [r] = await db().select().from(schema.dnsAccounts).where(eq(schema.dnsAccounts.id, id))
  if (!r) throw createError({ statusCode: 404, statusMessage: 'Compte DNS introuvable' })
  return r
}

async function credentialsOf(r: Row): Promise<DnsCredentials> {
  const [s] = await db().select({ envelope: schema.secrets.envelope }).from(schema.secrets).where(eq(schema.secrets.id, r.secretId))
  if (!s) throw new Error(`Identifiants du compte DNS ${r.name} introuvables`)
  return dnsCredentials.parse(JSON.parse(decryptSecret(s.envelope)))
}

export async function apiOf(r: Row): Promise<DnsApi> {
  return dnsApi(await credentialsOf(r), { cloudflareApi: env().ACME_DNS_CLOUDFLARE_API })
}

/** Zones visibles avec ces identifiants (contrôle avant enregistrement). */
async function probe(creds: DnsCredentials): Promise<DnsCheckResult> {
  try {
    const zones = (await dnsApi(creds, { cloudflareApi: env().ACME_DNS_CLOUDFLARE_API }).zones()).map(z => z.toLowerCase()).sort()
    return { ok: true, zones, error: null }
  }
  catch (err) {
    return { ok: false, zones: [], error: (err as Error).message }
  }
}

export async function createDnsAccount(input: DnsAccountInput, userId: string | null): Promise<{ account: DnsAccountDto, check: DnsCheckResult }> {
  const check = await probe(input.credentials)
  if (!check.ok) throw createError({ statusCode: 422, statusMessage: check.error ?? 'Identifiants refusés', data: { errors: { credentials: check.error } } })
  // Zones non précisées : toutes celles que les identifiants permettent de gérer.
  const zones = input.zones.length ? input.zones : check.zones
  const { envelope, keyId } = encryptSecret(JSON.stringify(input.credentials))
  const row = await db().transaction(async (tx) => {
    const [secret] = await tx.insert(schema.secrets).values({ purpose: 'dns_account', envelope, keyId }).returning({ id: schema.secrets.id })
    const [r] = await tx.insert(schema.dnsAccounts).values({ name: input.name, provider: input.credentials.provider, zones, wildcard: input.wildcard, secretId: secret!.id, lastCheckAt: new Date(), createdBy: userId }).returning()
    return r!
  }).catch((err: { code?: string }) => {
    if (err.code === '23505') throw createError({ statusCode: 409, statusMessage: 'Un compte DNS porte déjà ce nom', data: { errors: { name: 'Nom déjà utilisé' } } })
    throw err
  })
  return { account: toDto(row), check }
}

export async function updateDnsAccount(id: string, patch: { name?: string, zones?: string[], wildcard?: boolean, credentials?: DnsCredentials }): Promise<DnsAccountDto> {
  const r = await rowOr404(id)
  if (patch.credentials && patch.credentials.provider !== r.provider) throw createError({ statusCode: 422, statusMessage: 'Le fournisseur d\'un compte ne change pas : créer un autre compte' })
  if (patch.credentials) {
    const check = await probe(patch.credentials)
    if (!check.ok) throw createError({ statusCode: 422, statusMessage: check.error ?? 'Identifiants refusés', data: { errors: { credentials: check.error } } })
    const { envelope, keyId } = encryptSecret(JSON.stringify(patch.credentials))
    await db().update(schema.secrets).set({ envelope, keyId }).where(eq(schema.secrets.id, r.secretId))
  }
  const [row] = await db().update(schema.dnsAccounts).set({
    ...(patch.name !== undefined ? { name: patch.name } : {}),
    ...(patch.zones !== undefined ? { zones: patch.zones } : {}),
    ...(patch.wildcard !== undefined ? { wildcard: patch.wildcard } : {}),
    ...(patch.credentials ? { lastCheckAt: new Date(), lastError: null } : {}),
  }).where(eq(schema.dnsAccounts.id, id)).returning()
  return toDto(row!)
}

export async function removeDnsAccount(id: string): Promise<{ name: string }> {
  const r = await rowOr404(id)
  await db().transaction(async (tx) => {
    await tx.delete(schema.dnsAccounts).where(eq(schema.dnsAccounts.id, id))
    await tx.delete(schema.secrets).where(eq(schema.secrets.id, r.secretId))
  })
  return { name: r.name }
}

/** Contrôle d'un compte enregistré : zones visibles, état mémorisé. */
export async function checkDnsAccount(id: string): Promise<DnsCheckResult> {
  const r = await rowOr404(id)
  const result = await probe(await credentialsOf(r))
  await db().update(schema.dnsAccounts).set({ lastCheckAt: new Date(), lastError: result.error }).where(eq(schema.dnsAccounts.id, id))
  return result
}

export async function dnsAccountRows(): Promise<Row[]> {
  return db().select().from(schema.dnsAccounts)
}

export async function markDnsError(id: string, error: string | null): Promise<void> {
  await db().update(schema.dnsAccounts).set({ lastError: error, lastCheckAt: new Date() }).where(eq(schema.dnsAccounts.id, id))
}
