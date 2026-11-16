/**
 * Chiffrement des secrets au repos (§19) : AES-256-GCM, clé maîtresse hors
 * PostgreSQL (variable d'environnement protégée ou secret Docker monté).
 *
 * Format d'enveloppe : `v1.<keyId>.<iv>.<tag>.<ciphertext>` (base64url).
 * Le keyId permet la rotation : on déchiffre avec l'ancienne clé, on
 * rechiffre avec la courante.
 */
import { createCipheriv, createDecipheriv, createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { env } from './env'

const ALGO = 'aes-256-gcm'
const VERSION = 'v1'

export interface Keyring {
  currentId: string
  keys: Map<string, Buffer>
}

function decodeKey(b64: string, label: string): Buffer {
  const key = Buffer.from(b64.trim(), 'base64')
  if (key.length !== 32) {
    throw new Error(`Clé ${label} invalide : 32 octets attendus en base64`)
  }
  return key
}

export function buildKeyring(currentId: string, currentB64: string, previous?: string): Keyring {
  const keys = new Map<string, Buffer>([[currentId, decodeKey(currentB64, currentId)]])
  for (const entry of (previous ?? '').split(',').map(s => s.trim()).filter(Boolean)) {
    const sep = entry.indexOf(':')
    if (sep <= 0) throw new Error('MASTER_KEYS_PREVIOUS : format attendu "id:base64,..."')
    const id = entry.slice(0, sep)
    keys.set(id, decodeKey(entry.slice(sep + 1), id))
  }
  return { currentId, keys }
}

let keyring: Keyring | undefined

export function getKeyring(): Keyring {
  if (!keyring) {
    const e = env()
    const raw = e.MASTER_KEY_FILE ? readFileSync(e.MASTER_KEY_FILE, 'utf8') : e.MASTER_KEY
    if (!raw) {
      throw new Error('Clé maîtresse absente : définir MASTER_KEY ou MASTER_KEY_FILE')
    }
    // Anciennes clés (rotation) : de préférence dans un fichier (secret Docker), sinon dans l'environnement.
    const previous = e.MASTER_KEYS_PREVIOUS_FILE ? readFileSync(e.MASTER_KEYS_PREVIOUS_FILE, 'utf8').trim() : e.MASTER_KEYS_PREVIOUS
    keyring = buildKeyring(e.MASTER_KEY_ID, raw, previous)
  }
  return keyring
}

export function encryptSecret(plaintext: string, ring: Keyring = getKeyring()): { envelope: string, keyId: string } {
  const key = ring.keys.get(ring.currentId)!
  const iv = randomBytes(12)
  const cipher = createCipheriv(ALGO, key, iv)
  // Le keyId est lié au chiffré comme donnée authentifiée.
  cipher.setAAD(Buffer.from(ring.currentId))
  const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()])
  const tag = cipher.getAuthTag()
  const parts = [VERSION, ring.currentId, iv.toString('base64url'), tag.toString('base64url'), ct.toString('base64url')]
  return { envelope: parts.join('.'), keyId: ring.currentId }
}

export function decryptSecret(envelope: string, ring: Keyring = getKeyring()): string {
  const parts = envelope.split('.')
  if (parts.length !== 5 || parts[0] !== VERSION) {
    throw new Error('Enveloppe de secret invalide')
  }
  const [, keyId, ivB64, tagB64, ctB64] = parts as [string, string, string, string, string]
  const key = ring.keys.get(keyId)
  if (!key) throw new Error(`Clé de chiffrement inconnue : ${keyId}`)
  const decipher = createDecipheriv(ALGO, key, Buffer.from(ivB64, 'base64url'))
  decipher.setAAD(Buffer.from(keyId))
  decipher.setAuthTag(Buffer.from(tagB64, 'base64url'))
  return Buffer.concat([decipher.update(Buffer.from(ctB64, 'base64url')), decipher.final()]).toString('utf8')
}

/** Chiffré à nouveau avec la clé courante ; null s'il l'est déjà. */
export function reencrypt(envelope: string, ring: Keyring = getKeyring()): { envelope: string, keyId: string } | null {
  if (!needsRotation(envelope, ring)) return null
  return encryptSecret(decryptSecret(envelope, ring), ring)
}

/** Oublie le trousseau chargé (tests, outil de rotation). */
export function resetKeyring(): void {
  keyring = undefined
}

export function needsRotation(envelope: string, ring: Keyring = getKeyring()): boolean {
  return envelope.split('.')[1] !== ring.currentId
}

export function sha256Hex(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex')
}

export function safeEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a)
  const bb = Buffer.from(b)
  return ba.length === bb.length && timingSafeEqual(ba, bb)
}

export function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString('base64url')
}
