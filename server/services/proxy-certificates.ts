/**
 * Certificats importés pour le Traefik géré : contrôle à l'import, clé privée
 * chiffrée (jamais renvoyée), mise en service à l'application du Traefik géré.
 */
import { and, eq } from 'drizzle-orm'
import { createError } from 'h3'
import type { ProxyCertificateDto } from '../../shared/schemas/managed-proxy'
import { db, schema } from '../db/client'
import { CertificateRejected, certificateCovers, parseCertificateBundle } from '../lib/proxy/certificates'
import { type ManagedCert, certEnvNames } from '../lib/proxy/managed'
import { decryptSecret, encryptSecret } from '../utils/crypto'

const EXPIRING_MS = 21 * 864e5

/** Clé courte et stable (noms de fichiers dans le conteneur, noms de variables). */
export const certKey = (id: string) => id.replace(/-/g, '').slice(0, 12)
/** Identité d'un certificat en service : identifiant, empreinte et rôle par défaut. */
const appliedId = (c: { id: string, fingerprint: string, isDefault: boolean }) => `${c.id}:${c.fingerprint.slice(0, 16)}:${c.isDefault ? 'd' : ''}`

export function certState(notAfter: Date, now = Date.now()): ProxyCertificateDto['state'] {
  const left = notAfter.getTime() - now
  return left <= 0 ? 'expired' : left < EXPIRING_MS ? 'expiring' : 'valid'
}

async function exposedHosts(endpointId: string): Promise<string[]> {
  const rows = await db().select({ exposures: schema.projectTargets.exposures }).from(schema.projectTargets).where(eq(schema.projectTargets.endpointId, endpointId))
  return [...new Set(rows.flatMap(r => r.exposures.map(e => e.host.toLowerCase())))].sort()
}

export async function listCertificates(endpointId: string): Promise<ProxyCertificateDto[]> {
  const [rows, hosts, [mp]] = await Promise.all([
    db().select().from(schema.proxyCertificates).where(eq(schema.proxyCertificates.endpointId, endpointId)),
    exposedHosts(endpointId),
    db().select({ applied: schema.managedProxies.appliedCertificates }).from(schema.managedProxies).where(eq(schema.managedProxies.endpointId, endpointId)),
  ])
  const applied = new Set(mp?.applied ?? [])
  return rows
    .map(r => ({
      id: r.id,
      domains: r.domains,
      subject: r.subject,
      issuer: r.issuer,
      notBefore: r.notBefore.toISOString(),
      notAfter: r.notAfter.toISOString(),
      fingerprint: r.fingerprint,
      selfSigned: r.selfSigned,
      keyType: r.keyType,
      isDefault: r.isDefault,
      createdAt: r.createdAt.toISOString(),
      state: certState(r.notAfter),
      covers: hosts.filter(h => certificateCovers(r.domains, h)),
      pendingApply: !applied.has(appliedId(r)),
      source: r.source,
    }))
    .sort((a, b) => Number(b.isDefault) - Number(a.isDefault) || a.notAfter.localeCompare(b.notAfter))
}

export async function importCertificate(endpointId: string, input: { certPem: string, keyPem: string, isDefault: boolean }, userId: string | null): Promise<{ certificate: ProxyCertificateDto, warnings: string[] }> {
  let parsed
  try {
    parsed = parseCertificateBundle(input.certPem, input.keyPem)
  }
  catch (err) {
    if (err instanceof CertificateRejected) throw createError({ statusCode: 422, statusMessage: err.message, data: { errors: { [err.field]: err.message } } })
    throw err
  }
  const [dup] = await db().select({ id: schema.proxyCertificates.id }).from(schema.proxyCertificates)
    .where(and(eq(schema.proxyCertificates.endpointId, endpointId), eq(schema.proxyCertificates.fingerprint, parsed.fingerprint)))
  if (dup) throw createError({ statusCode: 409, statusMessage: 'Ce certificat est déjà importé pour cet endpoint' })

  const { envelope, keyId } = encryptSecret(input.keyPem.trim())
  const id = await db().transaction(async (tx) => {
    const [secret] = await tx.insert(schema.secrets).values({ purpose: 'proxy_certificate_key', envelope, keyId }).returning({ id: schema.secrets.id })
    if (input.isDefault) await tx.update(schema.proxyCertificates).set({ isDefault: false }).where(eq(schema.proxyCertificates.endpointId, endpointId))
    const [row] = await tx.insert(schema.proxyCertificates).values({
      endpointId,
      domains: parsed.domains,
      subject: parsed.subject,
      issuer: parsed.issuer,
      notBefore: new Date(parsed.notBefore),
      notAfter: new Date(parsed.notAfter),
      fingerprint: parsed.fingerprint,
      selfSigned: parsed.selfSigned,
      keyType: parsed.keyType,
      certPem: parsed.chainPem,
      keySecretId: secret!.id,
      isDefault: input.isDefault,
      createdBy: userId,
    }).returning({ id: schema.proxyCertificates.id })
    return row!.id
  })
  const certificate = (await listCertificates(endpointId)).find(c => c.id === id)!
  return { certificate, warnings: parsed.warnings }
}

export async function setDefaultCertificate(endpointId: string, id: string, isDefault: boolean): Promise<void> {
  await db().transaction(async (tx) => {
    if (isDefault) await tx.update(schema.proxyCertificates).set({ isDefault: false }).where(eq(schema.proxyCertificates.endpointId, endpointId))
    const r = await tx.update(schema.proxyCertificates).set({ isDefault }).where(and(eq(schema.proxyCertificates.endpointId, endpointId), eq(schema.proxyCertificates.id, id))).returning({ id: schema.proxyCertificates.id })
    if (!r.length) throw createError({ statusCode: 404, statusMessage: 'Certificat introuvable' })
  })
}

export async function removeCertificate(endpointId: string, id: string): Promise<{ domains: string[] }> {
  const [row] = await db().select().from(schema.proxyCertificates).where(and(eq(schema.proxyCertificates.endpointId, endpointId), eq(schema.proxyCertificates.id, id)))
  if (!row) throw createError({ statusCode: 404, statusMessage: 'Certificat introuvable' })
  await db().transaction(async (tx) => {
    await tx.delete(schema.proxyCertificates).where(eq(schema.proxyCertificates.id, id))
    await tx.delete(schema.secrets).where(eq(schema.secrets.id, row.keySecretId))
  })
  return { domains: row.domains }
}

/** Certificats à mettre en service (expirés exclus) : description pour le Compose, valeurs pour l'environnement de docker compose. */
export async function certificatesForApply(endpointId: string): Promise<{ certs: ManagedCert[], env: { name: string, value: string }[], applied: string[] }> {
  const rows = (await db().select().from(schema.proxyCertificates).where(eq(schema.proxyCertificates.endpointId, endpointId)))
    .filter(r => r.notAfter.getTime() > Date.now())
  const env: { name: string, value: string }[] = []
  for (const r of rows) {
    const [s] = await db().select({ envelope: schema.secrets.envelope }).from(schema.secrets).where(eq(schema.secrets.id, r.keySecretId))
    if (!s) throw new Error(`Clé du certificat ${r.id} introuvable`)
    const k = certKey(r.id)
    const names = certEnvNames(k)
    env.push({ name: names.cert, value: r.certPem }, { name: names.key, value: decryptSecret(s.envelope) })
  }
  return { certs: rows.map(r => ({ key: certKey(r.id), isDefault: r.isDefault })), env, applied: rows.map(appliedId) }
}

/** Identités en service attendues (pour détecter une application à refaire). */
export async function expectedApplied(endpointId: string): Promise<string[]> {
  const rows = (await db().select().from(schema.proxyCertificates).where(eq(schema.proxyCertificates.endpointId, endpointId))).filter(r => r.notAfter.getTime() > Date.now())
  return rows.map(appliedId).sort()
}
