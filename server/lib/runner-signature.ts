/**
 * Signature des requêtes Plateforme → Target Runner (complément du mTLS).
 *
 * Chaîne signée (HMAC-SHA256, clé partagée propre à chaque Runner) :
 *   v1\n<MÉTHODE>\n<chemin + query>\n<horodatage ms>\n<nonce>\n<sha256 du corps en hex>
 *
 * Le Runner refuse : signature invalide, horodatage hors d'une fenêtre de
 * ±60 s, nonce déjà vu (anti-rejeu). Pour un dépôt de fichier en flux, le
 * hash signé est celui annoncé dans l'en-tête X-Content-SHA256, que le
 * Runner revérifie sur les octets réellement reçus.
 */
import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto'

export const SIGNATURE_VERSION = 'v1'
export const MAX_CLOCK_SKEW_MS = 60_000
export const EMPTY_SHA256 = createHash('sha256').update('').digest('hex')

export const HEADERS = {
  timestamp: 'x-runner-timestamp',
  nonce: 'x-runner-nonce',
  signature: 'x-runner-signature',
  contentSha256: 'x-content-sha256',
  requestId: 'x-request-id',
  actor: 'x-runner-actor',
} as const

export function canonicalString(method: string, pathWithQuery: string, timestamp: string, nonce: string, bodySha256: string): string {
  return [SIGNATURE_VERSION, method.toUpperCase(), pathWithQuery, timestamp, nonce, bodySha256].join('\n')
}

export function sign(key: Buffer, method: string, pathWithQuery: string, bodySha256: string, now = Date.now()) {
  const timestamp = String(now)
  const nonce = randomBytes(16).toString('hex')
  const signature = createHmac('sha256', key).update(canonicalString(method, pathWithQuery, timestamp, nonce, bodySha256)).digest('hex')
  return {
    [HEADERS.timestamp]: timestamp,
    [HEADERS.nonce]: nonce,
    [HEADERS.signature]: `${SIGNATURE_VERSION}=${signature}`,
    [HEADERS.contentSha256]: bodySha256,
  }
}

export type VerifyResult = { ok: true } | { ok: false, reason: string }

/** Mémoire des nonces récents, purgée au-delà de la fenêtre de validité. */
export class NonceCache {
  private readonly seen = new Map<string, number>()

  /** Renvoie false si le nonce a déjà été utilisé. */
  remember(nonce: string, now = Date.now()): boolean {
    for (const [n, ts] of this.seen) if (now - ts > 2 * MAX_CLOCK_SKEW_MS) this.seen.delete(n)
    if (this.seen.has(nonce)) return false
    this.seen.set(nonce, now)
    return true
  }
}

export function verify(
  key: Buffer,
  input: { method: string, pathWithQuery: string, headers: Record<string, string | string[] | undefined> },
  nonces: NonceCache,
  now = Date.now(),
): VerifyResult {
  const h = (name: string) => {
    const v = input.headers[name]
    return Array.isArray(v) ? v[0] : v
  }
  const timestamp = h(HEADERS.timestamp)
  const nonce = h(HEADERS.nonce)
  const signature = h(HEADERS.signature)
  const bodySha256 = h(HEADERS.contentSha256)
  if (!timestamp || !nonce || !signature || !bodySha256) return { ok: false, reason: 'en-têtes de signature manquants' }
  if (!/^\d{13}$/.test(timestamp) || !/^[a-f0-9]{32}$/.test(nonce) || !/^[a-f0-9]{64}$/.test(bodySha256)) return { ok: false, reason: 'en-têtes de signature mal formés' }
  if (Math.abs(now - Number(timestamp)) > MAX_CLOCK_SKEW_MS) return { ok: false, reason: 'horodatage hors fenêtre (horloges désynchronisées ?)' }

  const expected = createHmac('sha256', key).update(canonicalString(input.method, input.pathWithQuery, timestamp, nonce, bodySha256)).digest('hex')
  const given = signature.startsWith(`${SIGNATURE_VERSION}=`) ? signature.slice(SIGNATURE_VERSION.length + 1) : ''
  const a = Buffer.from(expected, 'hex')
  const b = Buffer.from(given, 'hex')
  if (a.length !== b.length || !timingSafeEqual(a, b)) return { ok: false, reason: 'signature invalide' }
  // Le nonce n'est mémorisé qu'après une signature valide : un tiers ne peut pas « brûler » des nonces.
  if (!nonces.remember(nonce, now)) return { ok: false, reason: 'requête rejouée (nonce déjà utilisé)' }
  return { ok: true }
}

export function sha256Hex(data: string | Buffer): string {
  return createHash('sha256').update(data).digest('hex')
}
