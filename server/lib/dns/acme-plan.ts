/**
 * Demande ACME d'un domaine : noms du certificat et défi. Avec un compte DNS couvrant le domaine,
 * DNS-01 (et, si le compte le prévoit, un certificat générique *.parent + parent, partagé par les
 * domaines voisins) ; sans compte, HTTP-01 servi par nginx classique ; un domaine générique exige
 * DNS-01.
 */
import { zoneFor } from './providers'

export interface DnsAccountLike { zones: readonly string[], wildcard: boolean }
export type AcmePlan = { names: string[], method: 'dns-01' | 'http-01' } | { skip: string }

/** Compte DNS d'un domaine : celui dont une zone le couvre, la plus précise. */
export function accountFor<T extends { zones: readonly string[] }>(accounts: readonly T[], host: string): T | null {
  let best: { a: T, len: number } | null = null
  for (const a of accounts) {
    const z = zoneFor(host.replace(/^\*\./, ''), a.zones)
    if (z && (!best || z.length > best.len)) best = { a, len: z.length }
  }
  return best?.a ?? null
}

export function acmePlan(host: string, account: DnsAccountLike | null, httpChallenge: boolean): AcmePlan {
  const h = host.toLowerCase()
  if (h.startsWith('*.')) {
    return account ? { names: [h, h.slice(2)], method: 'dns-01' } : { skip: `${h} : certificat générique, un compte DNS couvrant ${h.slice(2)} est requis (DNS-01)` }
  }
  if (account) {
    const zone = zoneFor(h, account.zones)
    const parent = h.slice(h.indexOf('.') + 1)
    if (account.wildcard && zone && h.includes('.') && parent.includes('.') && (parent === zone || parent.endsWith(`.${zone}`))) {
      return { names: [`*.${parent}`, parent], method: 'dns-01' }
    }
    return { names: [h], method: 'dns-01' }
  }
  return httpChallenge ? { names: [h], method: 'http-01' } : { skip: `${h} : aucun compte DNS ne couvre ce domaine (nginx-proxy : DNS-01 uniquement)` }
}
