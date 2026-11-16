import { randomBytes } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { buildKeyring, decryptSecret, encryptSecret, needsRotation } from '../../server/utils/crypto'

const k1 = randomBytes(32).toString('base64')
const k2 = randomBytes(32).toString('base64')

describe('chiffrement des secrets', () => {
  const ring = buildKeyring('k1', k1)

  it('chiffre et déchiffre', () => {
    const { envelope, keyId } = encryptSecret('ptr_secret_token_value', ring)
    expect(keyId).toBe('k1')
    expect(envelope).not.toContain('ptr_secret')
    expect(decryptSecret(envelope, ring)).toBe('ptr_secret_token_value')
  })

  it('produit un chiffré différent à chaque appel (IV aléatoire)', () => {
    expect(encryptSecret('x', ring).envelope).not.toBe(encryptSecret('x', ring).envelope)
  })

  it('détecte une altération', () => {
    const { envelope } = encryptSecret('valeur', ring)
    const parts = envelope.split('.')
    const ct = Buffer.from(parts[4]!, 'base64url')
    ct[0]! ^= 1
    parts[4] = ct.toString('base64url')
    expect(() => decryptSecret(parts.join('.'), ring)).toThrow()
  })

  it('refuse de déchiffrer en changeant le keyId de l\'enveloppe', () => {
    const both = buildKeyring('k2', k2, `k1:${k1}`)
    const { envelope } = encryptSecret('valeur', both)
    expect(() => decryptSecret(envelope.replace('.k2.', '.k1.'), both)).toThrow()
  })

  it('supporte la rotation de clé', () => {
    const old = encryptSecret('valeur', ring).envelope
    const rotated = buildKeyring('k2', k2, `k1:${k1}`)
    expect(needsRotation(old, rotated)).toBe(true)
    expect(decryptSecret(old, rotated)).toBe('valeur')
    const fresh = encryptSecret('valeur', rotated).envelope
    expect(needsRotation(fresh, rotated)).toBe(false)
  })

  it('rejette une clé de mauvaise taille', () => {
    expect(() => buildKeyring('k1', randomBytes(16).toString('base64'))).toThrow(/32 octets/)
  })
})
