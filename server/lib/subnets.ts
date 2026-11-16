/**
 * Sous-réseaux IPv4 (notation CIDR) : lecture, recouvrement et attribution dans une plage.
 * Sert à donner aux réseaux des projets des sous-réseaux de taille adaptée (ex. /27) au lieu
 * des /16 que Docker attribue par défaut.
 */

export interface Cidr { network: number, prefix: number, text: string }

const CIDR_RE = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})\/(\d{1,2})$/

/** CIDR lu et normalisé (adresse réseau), ou null s'il est invalide. */
export function parseCidr(text: string): Cidr | null {
  const m = CIDR_RE.exec(text.trim())
  if (!m) return null
  const octets = m.slice(1, 5).map(Number)
  const prefix = Number(m[5])
  if (octets.some(o => o > 255) || prefix > 32) return null
  const ip = ((octets[0]! << 24) >>> 0) + (octets[1]! << 16) + (octets[2]! << 8) + octets[3]!
  const mask = prefix === 0 ? 0 : (0xFFFFFFFF << (32 - prefix)) >>> 0
  const network = (ip & mask) >>> 0
  return { network, prefix, text: `${toIp(network)}/${prefix}` }
}

function toIp(n: number): string {
  return [n >>> 24, (n >>> 16) & 255, (n >>> 8) & 255, n & 255].join('.')
}

const size = (c: Cidr) => 2 ** (32 - c.prefix)

export function overlaps(a: Cidr, b: Cidr): boolean {
  return a.network < b.network + size(b) && b.network < a.network + size(a)
}

/** `inner` entièrement contenu dans `outer`. */
export function within(inner: Cidr, outer: Cidr): boolean {
  return inner.prefix >= outer.prefix && inner.network >= outer.network && inner.network + size(inner) <= outer.network + size(outer)
}

/**
 * Premier sous-réseau libre de taille `prefix` dans `pool`, hors des plages occupées.
 * Null si la plage est épuisée.
 */
export function firstFree(pool: Cidr, prefix: number, taken: readonly Cidr[]): Cidr | null {
  if (prefix < pool.prefix || prefix > 30) return null
  const step = 2 ** (32 - prefix)
  for (let n = pool.network; n + step <= pool.network + size(pool); n += step) {
    const candidate: Cidr = { network: n >>> 0, prefix, text: `${toIp(n >>> 0)}/${prefix}` }
    if (!taken.some(t => overlaps(candidate, t))) return candidate
  }
  return null
}

/** Nombre de réseaux de taille `prefix` que contient la plage. */
export function capacity(pool: Cidr, prefix: number): number {
  return prefix < pool.prefix ? 0 : 2 ** (prefix - pool.prefix)
}
