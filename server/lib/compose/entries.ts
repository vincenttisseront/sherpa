/**
 * Normalisation des ports et des volumes d'un service Compose (syntaxes
 * courte et longue) en une forme unique, contrôlable par la plateforme.
 */
export interface PortEntry {
  target: number
  targetEnd: number
  published: number | null
  publishedEnd: number | null
  hostIp: string | null
  protocol: 'tcp' | 'udp'
}

export interface MountEntry {
  type: 'bind' | 'volume' | 'tmpfs' | 'other'
  source: string | null
  target: string
  readOnly: boolean
  /** Forme d'origine (chaîne ou objet), pour reconstruire après réécriture. */
  long: boolean
  raw: unknown
}

export class EntryError extends Error {}

const MAX_RANGE = 20

function parseRange(s: string, what: string): [number, number] {
  const m = /^(\d{1,5})(?:-(\d{1,5}))?$/.exec(s)
  if (!m) throw new EntryError(`${what} invalide : ${s}`)
  const a = Number(m[1])
  const b = m[2] ? Number(m[2]) : a
  if (a < 1 || b > 65535 || b < a) throw new EntryError(`${what} hors limites : ${s}`)
  if (b - a + 1 > MAX_RANGE) throw new EntryError(`Plage de ports trop large (${b - a + 1} ports, ${MAX_RANGE} maximum) : ${s}`)
  return [a, b]
}

/**
 * Formes courtes acceptées : "80", "8080:80", "127.0.0.1:8080:80",
 * "[::1]:8080:80", "8080-8085:80-85", avec suffixe "/tcp" ou "/udp".
 */
export function parsePort(raw: unknown): PortEntry {
  if (typeof raw === 'number') raw = String(raw)
  if (typeof raw === 'string') {
    let s = raw.trim()
    let protocol: 'tcp' | 'udp' = 'tcp'
    const slash = s.lastIndexOf('/')
    if (slash >= 0) {
      const p = s.slice(slash + 1).toLowerCase()
      if (p !== 'tcp' && p !== 'udp') throw new EntryError(`Protocole non supporté : ${p}`)
      protocol = p
      s = s.slice(0, slash)
    }
    let hostIp: string | null = null
    const v6 = /^\[([0-9a-f:]+)\]:(.*)$/i.exec(s)
    if (v6) {
      hostIp = v6[1]!
      s = v6[2]!
    }
    const parts = s.split(':')
    if (!v6 && parts.length === 3) hostIp = parts.shift()!
    if (parts.length > 2) throw new EntryError(`Port invalide : ${raw}`)
    const [t0, t1] = parseRange(parts.at(-1)!, 'Port du conteneur')
    let published: [number, number] | null = null
    if (parts.length === 2 && parts[0] !== '') published = parseRange(parts[0]!, 'Port publié')
    if (published && published[1] - published[0] !== t1 - t0 && published[0] !== published[1]) throw new EntryError(`Plages de tailles différentes : ${raw}`)
    return { target: t0, targetEnd: t1, published: published?.[0] ?? null, publishedEnd: published?.[1] ?? null, hostIp: hostIp || null, protocol }
  }
  if (raw && typeof raw === 'object') {
    const o = raw as Record<string, unknown>
    if (o.mode === 'ingress') throw new EntryError('Mode ingress réservé à Swarm')
    const target = Number(o.target)
    if (!Number.isInteger(target) || target < 1 || target > 65535) throw new EntryError(`Port du conteneur invalide : ${String(o.target)}`)
    let published: [number, number] | null = null
    if (o.published !== undefined && o.published !== null && o.published !== '') published = parseRange(String(o.published), 'Port publié')
    const protocol = String(o.protocol ?? 'tcp').toLowerCase()
    if (protocol !== 'tcp' && protocol !== 'udp') throw new EntryError(`Protocole non supporté : ${protocol}`)
    return { target, targetEnd: target, published: published?.[0] ?? null, publishedEnd: published?.[1] ?? null, hostIp: (o.host_ip as string) || null, protocol }
  }
  throw new EntryError('Entrée de port illisible')
}

/** Une entrée de volume courte : "source:cible[:options]" ou "cible" (volume anonyme). */
export function parseMount(raw: unknown): MountEntry {
  if (typeof raw === 'string') {
    // Les chemins Windows (C:\…) ne sont pas supportés sur un hôte Linux.
    const parts = raw.split(':')
    if (parts.length === 1) return { type: 'volume', source: null, target: parts[0]!, readOnly: false, long: false, raw }
    if (parts.length > 3) throw new EntryError(`Volume invalide : ${raw}`)
    const [source, target, opts = ''] = parts as [string, string, string?]
    const options = opts.split(',').filter(Boolean)
    for (const o of options) {
      if (!['ro', 'rw', 'z', 'Z', 'cached', 'delegated', 'consistent', 'nocopy'].includes(o)) throw new EntryError(`Option de volume inconnue : ${o}`)
    }
    const isPath = source.startsWith('/') || source.startsWith('.') || source.startsWith('~')
    return { type: isPath ? 'bind' : 'volume', source, target, readOnly: options.includes('ro'), long: false, raw }
  }
  if (raw && typeof raw === 'object') {
    const o = raw as Record<string, unknown>
    const type = String(o.type ?? 'volume')
    const known = type === 'bind' || type === 'volume' || type === 'tmpfs'
    return {
      type: known ? type as MountEntry['type'] : 'other',
      source: typeof o.source === 'string' ? o.source : null,
      target: String(o.target ?? ''),
      readOnly: o.read_only === true,
      long: true,
      raw,
    }
  }
  throw new EntryError('Entrée de volume illisible')
}

/** Reconstruit une entrée de volume après réécriture de la source. */
/** Montage en lecture seule (options conservées). */
export function readOnlyMount(m: MountEntry): unknown {
  if (m.long) return { ...(m.raw as Record<string, unknown>), read_only: true }
  const [src, target, opts] = String(m.raw).split(':')
  const options = (opts ?? '').split(',').filter(o => o && o !== 'rw' && o !== 'ro')
  return [src, target, ['ro', ...options].join(',')].join(':')
}

export function rebuildMount(m: MountEntry, source: string): unknown {
  if (m.long) return { ...(m.raw as Record<string, unknown>), source }
  const parts = String(m.raw).split(':')
  return [source, ...parts.slice(1)].join(':')
}
