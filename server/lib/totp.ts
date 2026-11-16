/**
 * Mot de passe à usage unique basé sur le temps (TOTP, RFC 6238 / HOTP, RFC 4226) : HMAC-SHA1,
 * 6 chiffres, pas de 30 s, compatible avec les applications d'authentification courantes. Fonctions pures.
 */
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto'

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'
export const TOTP_STEP_S = 30
export const TOTP_DIGITS = 6

export function base32Encode(buf: Buffer): string {
  let bits = 0
  let value = 0
  let out = ''
  for (const byte of buf) {
    value = (value << 8) | byte
    bits += 8
    while (bits >= 5) {
      out += ALPHABET[(value >>> (bits - 5)) & 31]
      bits -= 5
    }
  }
  if (bits > 0) out += ALPHABET[(value << (5 - bits)) & 31]
  return out
}

export function base32Decode(text: string): Buffer {
  const clean = text.toUpperCase().replace(/[\s=-]/g, '')
  let bits = 0
  let value = 0
  const out: number[] = []
  for (const c of clean) {
    const i = ALPHABET.indexOf(c)
    if (i < 0) throw new Error('Secret base32 invalide')
    value = (value << 5) | i
    bits += 5
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255)
      bits -= 8
    }
  }
  return Buffer.from(out)
}

/** Secret de 160 bits (taille recommandée), en base32. */
export const generateTotpSecret = () => base32Encode(randomBytes(20))

/** Code à 6 chiffres du pas de temps `step` (secondes écoulées depuis 1970 ÷ 30). */
export function totpAt(secretBase32: string, step: number, digits = TOTP_DIGITS): string {
  const counter = Buffer.alloc(8)
  counter.writeBigUInt64BE(BigInt(step))
  const h = createHmac('sha1', base32Decode(secretBase32)).update(counter).digest()
  const o = h[h.length - 1]! & 0xF
  const n = ((h[o]! & 0x7F) << 24) | (h[o + 1]! << 16) | (h[o + 2]! << 8) | h[o + 3]!
  return String(n % 10 ** digits).padStart(digits, '0')
}

export const stepOf = (nowMs: number) => Math.floor(nowMs / 1000 / TOTP_STEP_S)

/**
 * Vérifie un code saisi, avec une tolérance d'un pas avant ou après (décalage d'horloge). Renvoie le pas accepté, ou
 * null. Un pas déjà utilisé (`lastStep`) ou antérieur est refusé : un même code ne sert qu'une fois.
 */
export function verifyTotp(secretBase32: string, input: string, nowMs: number, lastStep: number | null): number | null {
  const code = input.replace(/\s/g, '')
  if (!/^\d{6}$/.test(code)) return null
  const now = stepOf(nowMs)
  for (const step of [now, now - 1, now + 1]) {
    if (lastStep !== null && step <= lastStep) continue
    const a = Buffer.from(totpAt(secretBase32, step))
    if (timingSafeEqual(a, Buffer.from(code))) return step
  }
  return null
}

/** Adresse otpauth:// lue par les applications (par QR code ou saisie). */
export const otpauthUrl = (secretBase32: string, account: string, issuer = 'Sherpa') =>
  `otpauth://totp/${encodeURIComponent(issuer)}:${encodeURIComponent(account)}?secret=${secretBase32}&issuer=${encodeURIComponent(issuer)}&algorithm=SHA1&digits=${TOTP_DIGITS}&period=${TOTP_STEP_S}`

/** Codes de secours : 10 codes de 10 caractères lisibles (sans 0/O/1/I), formatés xxxxx-xxxxx. */
export function generateRecoveryCodes(n = 10): string[] {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'
  return Array.from({ length: n }, () => {
    const raw = Array.from(randomBytes(10), b => chars[b % chars.length]).join('')
    return `${raw.slice(0, 5)}-${raw.slice(5)}`
  })
}
/** Forme canonique d'un code de secours saisi (casse, tirets, espaces). */
export const normalizeRecovery = (s: string) => s.toUpperCase().replace(/[\s-]/g, '')
