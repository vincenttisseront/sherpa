import { describe, expect, it } from 'vitest'
import { base32Decode, base32Encode, generateRecoveryCodes, generateTotpSecret, normalizeRecovery, otpauthUrl, stepOf, totpAt, verifyTotp } from '../../server/lib/totp'

// Secret de test de la RFC 6238 (« 12345678901234567890 » en ASCII), SHA-1.
const RFC_SECRET = base32Encode(Buffer.from('12345678901234567890'))

describe('TOTP (RFC 6238)', () => {
  it('vecteurs de la RFC, tronqués à 6 chiffres', () => {
    // Table de l'annexe B (codes à 8 chiffres 94287082, 07081804, 14050471, 89005924, 69279037, 65353130 ; 6 derniers chiffres).
    const cases: [number, string][] = [[59, '287082'], [1111111109, '081804'], [1111111111, '050471'], [1234567890, '005924'], [2000000000, '279037'], [20000000000, '353130']]
    for (const [t, code] of cases) expect(totpAt(RFC_SECRET, stepOf(t * 1000))).toBe(code)
  })
  it('base32 : aller-retour et rejet des caractères invalides', () => {
    const buf = Buffer.from('Sherpa!')
    expect(base32Decode(base32Encode(buf)).equals(buf)).toBe(true)
    expect(base32Decode('mfrg gzdf-mztw q===').toString()).toBe('abcdefgh')
    expect(() => base32Decode('abc1')).toThrow()
    expect(generateTotpSecret()).toMatch(/^[A-Z2-7]{32}$/)
  })
  it('vérification : fenêtre de ±1 pas, pas de rejeu, mauvais formats refusés', () => {
    const now = 1_800_000_000_000
    const step = stepOf(now)
    expect(verifyTotp(RFC_SECRET, totpAt(RFC_SECRET, step), now, null)).toBe(step)
    expect(verifyTotp(RFC_SECRET, totpAt(RFC_SECRET, step - 1), now, null)).toBe(step - 1)
    expect(verifyTotp(RFC_SECRET, totpAt(RFC_SECRET, step + 1), now, null)).toBe(step + 1)
    expect(verifyTotp(RFC_SECRET, totpAt(RFC_SECRET, step - 2), now, null)).toBeNull()
    // Le même code ne passe qu'une fois ; un code d'un pas plus ancien après un plus récent non plus.
    expect(verifyTotp(RFC_SECRET, totpAt(RFC_SECRET, step), now, step)).toBeNull()
    expect(verifyTotp(RFC_SECRET, totpAt(RFC_SECRET, step - 1), now, step)).toBeNull()
    expect(verifyTotp(RFC_SECRET, '12345', now, null)).toBeNull()
    expect(verifyTotp(RFC_SECRET, 'abcdef', now, null)).toBeNull()
    expect(verifyTotp(RFC_SECRET, ` ${totpAt(RFC_SECRET, step).slice(0, 3)} ${totpAt(RFC_SECRET, step).slice(3)} `, now, null)).toBe(step)
  })
  it('adresse otpauth et codes de secours', () => {
    const url = otpauthUrl('JBSWY3DPEHPK3PXP', 'moi@exemple.fr')
    expect(url).toBe('otpauth://totp/Sherpa:moi%40exemple.fr?secret=JBSWY3DPEHPK3PXP&issuer=Sherpa&algorithm=SHA1&digits=6&period=30')
    const codes = generateRecoveryCodes()
    expect(codes).toHaveLength(10)
    expect(new Set(codes).size).toBe(10)
    expect(codes.every(c => /^[A-HJ-NP-Z2-9]{5}-[A-HJ-NP-Z2-9]{5}$/.test(c))).toBe(true)
    expect(normalizeRecovery(' abcde-fgh23 ')).toBe('ABCDEFGH23')
  })
})
