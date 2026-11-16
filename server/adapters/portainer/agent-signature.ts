/**
 * Signature des requêtes vers un agent Portainer en mode AGENT_SECRET.
 *
 * L'agent vérifie, pour chaque requête, une signature ECDSA P-256 du secret
 * (condensat MD5, signature r‖s encodée en base64 sans remplissage) avec la clé
 * publique fournie (DER PKIX en hexadécimal). Avec un secret, toute clé qui signe
 * le secret est acceptée : la paire est donc propre au processus, jamais stockée.
 * Le secret lui-même ne circule jamais.
 */
import { type KeyObject, createHash, generateKeyPairSync, sign } from 'node:crypto'
import { trimEndChars } from '../../../shared/utils/trim'

export const AGENT_SIGNATURE_HEADER = 'X-PortainerAgent-Signature'
export const AGENT_PUBLIC_KEY_HEADER = 'X-PortainerAgent-PublicKey'

let pair: { privateKey: KeyObject, publicKeyHex: string } | null = null
const signatures = new Map<string, string>()

function keys() {
  if (!pair) {
    const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' })
    pair = { privateKey, publicKeyHex: publicKey.export({ type: 'spki', format: 'der' }).toString('hex') }
  }
  return pair
}

/** Signature du secret, telle que l'agent la vérifie (ECDSA avec MD5). */
export function signAgentSecret(secret: string, privateKey: KeyObject = keys().privateKey): string {
  return trimEndChars(sign('md5', Buffer.from(secret, 'utf8'), { key: privateKey, dsaEncoding: 'ieee-p1363' }).toString('base64'), '=')
}

export function agentHeaders(secret: string): Record<string, string> {
  const k = keys()
  // La signature ne dépend que du secret : calculée une fois (indexée par empreinte, pas par le secret).
  const cacheKey = createHash('sha256').update(secret).digest('hex')
  let sig = signatures.get(cacheKey)
  if (!sig) {
    sig = signAgentSecret(secret, k.privateKey)
    if (signatures.size > 200) signatures.clear()
    signatures.set(cacheKey, sig)
  }
  return { [AGENT_PUBLIC_KEY_HEADER]: k.publicKeyHex, [AGENT_SIGNATURE_HEADER]: sig }
}
