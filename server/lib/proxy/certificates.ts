/**
 * Certificats importés pour le Traefik géré (sans ACME, ou pour des domaines
 * précis) : contrôle du couple certificat / clé avant tout enregistrement.
 * La clé privée n'est que validée ici ; elle est ensuite chiffrée par l'appelant
 * et n'est jamais renvoyée, journalisée ni écrite dans le Compose.
 */
import { X509Certificate, createHash, createPrivateKey, type KeyObject } from 'node:crypto'

export class CertificateRejected extends Error {
  constructor(message: string, public readonly field: 'certPem' | 'keyPem') {
    super(message)
    this.name = 'CertificateRejected'
  }
}

export interface ParsedCertificate {
  /** Domaines couverts (SAN DNS, sinon CN). */
  domains: string[]
  subject: string
  issuer: string
  notBefore: string
  notAfter: string
  /** Empreinte SHA-256 du certificat feuille (hexadécimal). */
  fingerprint: string
  selfSigned: boolean
  /** Chaîne normalisée (feuille puis intermédiaires), PEM. */
  chainPem: string
  keyType: string
  warnings: string[]
}

const PEM_CERT = /-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/g
const MAX_PEM = 64 * 1024

const cn = (dn: string) => /(?:^|\n)CN=([^\n]+)/.exec(dn)?.[1]?.trim() ?? null
const label = (dn: string) => cn(dn) ?? /(?:^|\n)O=([^\n]+)/.exec(dn)?.[1]?.trim() ?? dn.replace(/\n/g, ', ')

/** Le certificat couvre-t-il l'hôte (nom exact ou joker d'un seul niveau) ? */
export function certificateCovers(domains: readonly string[], host: string): boolean {
  const h = host.toLowerCase()
  return domains.some((d) => {
    const x = d.toLowerCase()
    if (x === h) return true
    if (!x.startsWith('*.')) return false
    const suffix = x.slice(1)
    return h.endsWith(suffix) && !h.slice(0, -suffix.length).includes('.')
  })
}

export function parseCertificateBundle(certPem: string, keyPem: string, now = Date.now()): ParsedCertificate {
  if (certPem.length > MAX_PEM) throw new CertificateRejected('Certificat trop volumineux', 'certPem')
  if (keyPem.length > MAX_PEM) throw new CertificateRejected('Clé trop volumineuse', 'keyPem')
  const blocks = certPem.match(PEM_CERT) ?? []
  if (!blocks.length) throw new CertificateRejected('Aucun certificat PEM (-----BEGIN CERTIFICATE-----)', 'certPem')
  if (/PRIVATE KEY/.test(certPem)) throw new CertificateRejected('Le champ certificat contient une clé privée : la placer dans le champ clé', 'certPem')

  let chain: X509Certificate[]
  try {
    chain = blocks.map(b => new X509Certificate(b))
  }
  catch {
    throw new CertificateRejected('Certificat illisible', 'certPem')
  }
  const leaf = chain[0]!
  const warnings: string[] = []

  let key: KeyObject
  try {
    key = createPrivateKey({ key: keyPem, format: 'pem' })
  }
  catch (err) {
    const code = (err as { code?: string }).code
    throw new CertificateRejected(code === 'ERR_MISSING_PASSPHRASE' ? 'Clé chiffrée par une phrase de passe : fournir la clé déchiffrée' : 'Clé privée PEM illisible', 'keyPem')
  }
  if (!leaf.checkPrivateKey(key)) throw new CertificateRejected('La clé privée ne correspond pas au certificat', 'keyPem')
  const type = key.asymmetricKeyType ?? 'inconnu'
  const bits = key.asymmetricKeyDetails?.modulusLength
  if (type === 'rsa' && bits && bits < 2048) throw new CertificateRejected(`Clé RSA de ${bits} bits : 2048 bits minimum`, 'keyPem')
  if (!['rsa', 'ec', 'ed25519', 'rsa-pss'].includes(type)) throw new CertificateRejected(`Type de clé non pris en charge : ${type}`, 'keyPem')

  const notAfter = new Date(leaf.validTo)
  const notBefore = new Date(leaf.validFrom)
  if (notAfter.getTime() <= now) throw new CertificateRejected(`Certificat expiré le ${notAfter.toLocaleDateString('fr-FR')}`, 'certPem')
  if (notBefore.getTime() > now) warnings.push(`Certificat valide seulement à partir du ${notBefore.toLocaleDateString('fr-FR')}`)
  if (notAfter.getTime() - now < 30 * 864e5) warnings.push(`Expire dans moins de 30 jours (${notAfter.toLocaleDateString('fr-FR')})`)
  if (leaf.ca) warnings.push('Certificat d\'autorité (CA) fourni comme certificat de serveur')

  // Chaîne : chaque certificat doit être émis par le suivant.
  for (let i = 0; i < chain.length - 1; i++) {
    if (!chain[i]!.checkIssued(chain[i + 1]!)) warnings.push(`Chaîne incohérente : le certificat ${i + 2} n'a pas émis le certificat ${i + 1} (ordre attendu : serveur, puis intermédiaires)`)
  }
  const selfSigned = leaf.checkIssued(leaf) && leaf.verify(leaf.publicKey)
  if (selfSigned) warnings.push('Certificat auto-signé : non reconnu par les navigateurs')
  else if (chain.length === 1) warnings.push('Aucun certificat intermédiaire fourni : certains clients ne pourront pas valider la chaîne')

  const sans = (leaf.subjectAltName ?? '').split(/,\s*/).filter(x => x.startsWith('DNS:')).map(x => x.slice(4).toLowerCase())
  const domains = [...new Set(sans.length ? sans : [cn(leaf.subject)?.toLowerCase()].filter((d): d is string => !!d))]
  if (!domains.length) throw new CertificateRejected('Aucun nom de domaine dans le certificat (SAN ou CN)', 'certPem')

  return {
    domains,
    subject: label(leaf.subject),
    issuer: label(leaf.issuer),
    notBefore: notBefore.toISOString(),
    notAfter: notAfter.toISOString(),
    fingerprint: createHash('sha256').update(leaf.raw).digest('hex'),
    selfSigned,
    chainPem: `${blocks.join('\n')}\n`,
    keyType: bits ? `${type.toUpperCase()} ${bits}` : type.toUpperCase(),
    warnings,
  }
}
