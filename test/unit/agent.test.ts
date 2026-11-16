import { createHash, createPublicKey, generateKeyPairSync, verify } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { AGENT_PUBLIC_KEY_HEADER, AGENT_SIGNATURE_HEADER, agentHeaders, signAgentSecret } from '../../server/adapters/portainer/agent-signature'
import { agentStackId, agentTransport } from '../../server/adapters/portainer/agent'

/** Vérification identique à celle de l'agent (crypto/ecdsa.go) : ECDSA P-256 sur MD5(secret), r‖s en base64 brut. */
function agentVerifies(secret: string, publicKeyHex: string, signature: string): boolean {
  const key = createPublicKey({ key: Buffer.from(publicKeyHex, 'hex'), format: 'der', type: 'spki' })
  const sig = Buffer.from(signature, 'base64')
  if (sig.length !== 64) return false
  return verify('md5', Buffer.from(secret), { key, dsaEncoding: 'ieee-p1363' }, sig)
}

describe('signature des requêtes vers un agent Portainer', () => {
  const secret = 'un-secret-de-test-assez-long'

  it('en-têtes attendus par l\'agent : clé DER en hexadécimal, signature base64 sans remplissage', () => {
    const h = agentHeaders(secret)
    expect(h[AGENT_PUBLIC_KEY_HEADER]).toMatch(/^[0-9a-f]+$/)
    expect(h[AGENT_SIGNATURE_HEADER]).toMatch(/^[A-Za-z0-9+/]+$/)
    expect(Buffer.from(h[AGENT_SIGNATURE_HEADER]!, 'base64')).toHaveLength(64)
    expect(agentVerifies(secret, h[AGENT_PUBLIC_KEY_HEADER]!, h[AGENT_SIGNATURE_HEADER]!)).toBe(true)
  })

  it('refusée avec un autre secret ; le secret ne figure jamais dans les en-têtes', () => {
    const h = agentHeaders(secret)
    expect(agentVerifies('autre-secret-quelconque', h[AGENT_PUBLIC_KEY_HEADER]!, h[AGENT_SIGNATURE_HEADER]!)).toBe(false)
    expect(JSON.stringify(h)).not.toContain(secret)
    expect(JSON.stringify(h)).not.toContain(createHash('md5').update(secret).digest('hex'))
  })

  it('signe le secret lui-même (pas son condensat déjà calculé)', () => {
    const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' })
    const sig = signAgentSecret(secret, privateKey)
    const hex = publicKey.export({ type: 'spki', format: 'der' }).toString('hex')
    expect(agentVerifies(secret, hex, sig)).toBe(true)
  })
})

describe('transports Docker', () => {
  const conn = { url: 'https://x', token: 'tok-secret-123', tlsVerify: true }
  it('agent : racine de l\'agent, requêtes signées sans le secret', () => {
    expect(agentTransport.dockerPrefix(1)).toBe('')
    const h = agentTransport.headers(conn)
    expect(Object.keys(h).sort()).toEqual([AGENT_PUBLIC_KEY_HEADER, AGENT_SIGNATURE_HEADER].sort())
    expect(JSON.stringify(h)).not.toContain('tok-secret-123')
  })
  it('identifiant de stack stable et positif', () => {
    expect(agentStackId('shop-staging')).toBe(agentStackId('shop-staging'))
    expect(agentStackId('shop-staging')).toBeGreaterThan(0)
    expect(agentStackId('shop-staging')).not.toBe(agentStackId('shop-prod'))
  })
})

describe('mise à jour manuelle des images', () => {
  it('ne récupère que les images de registre, jamais celles construites par la plateforme', async () => {
    const { registryServices } = await import('../../server/adapters/portainer/stacks')
    expect(registryServices('services:\n  web:\n    image: platform/demo-web:r-0001\n  db:\n    image: postgres:18-alpine\n  cache:\n    image: docker.io/valkey/valkey:9\n')).toEqual(['db', 'cache'])
  })
})
