/**
 * Domaines exposés via Traefik (§11).
 * Un motif « *.apps.exemple.fr » couvre exactement UN niveau : « shop.apps.exemple.fr »
 * oui, « a.b.apps.exemple.fr » et « apps.exemple.fr » non.
 */
export const HOSTNAME_RE = /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z][a-z0-9-]{0,62}$/

export function normalizeHost(host: string): string {
  return host.trim().toLowerCase().replace(/\.$/, '')
}

export function matchesDomainPattern(host: string, pattern: string): boolean {
  const h = normalizeHost(host)
  const p = normalizeHost(pattern)
  if (!p.startsWith('*.')) return h === p
  const suffix = p.slice(1) // ".apps.exemple.fr"
  if (!h.endsWith(suffix)) return false
  const label = h.slice(0, -suffix.length)
  return label.length > 0 && !label.includes('.')
}

export function isAllowedHost(host: string, patterns: readonly string[]): boolean {
  return patterns.some(p => matchesDomainPattern(host, p))
}

export const PATH_PREFIX_RE = /^\/[A-Za-z0-9._~\-/]*$/
export const MIDDLEWARE_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,99}(?:@[a-z]+)?$/
