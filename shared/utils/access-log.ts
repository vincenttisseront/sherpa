/**
 * Journal d'accès des reverse proxies nginx lu sur la sortie du conteneur : format JSON de la
 * console (domaine, durées, amont), format « vhost » de nginx-proxy (domaine en tête) ou format
 * « combined » de nginx (sans domaine). Lignes d'erreur de nginx relevées à part. Statistiques :
 * statuts, durées, domaines, chemins, clients, rythme par minute.
 */

export interface AccessEntry {
  time: string | null
  host: string | null
  remote: string | null
  method: string | null
  path: string
  status: number
  bytes: number | null
  /** Durée totale de la requête (s). */
  duration: number | null
  upstream: string | null
  upstreamTime: number | null
  referer: string | null
  agent: string | null
  format: 'console' | 'vhost' | 'combined'
}

export interface AccessError { time: string | null, level: string, message: string, host: string | null }

export interface AccessStats {
  requests: number
  status: Record<'2xx' | '3xx' | '4xx' | '5xx' | 'other', number>
  bytes: number
  p50: number | null
  p95: number | null
  first: string | null
  last: string | null
  hosts: { host: string, requests: number, errors: number, p95: number | null }[]
  paths: { path: string, requests: number, errors: number }[]
  remotes: { remote: string, requests: number }[]
  perMinute: { minute: string, requests: number, errors: number }[]
}

export type StatusClass = keyof AccessStats['status']

const MONTHS: Record<string, string> = { Jan: '01', Feb: '02', Mar: '03', Apr: '04', May: '05', Jun: '06', Jul: '07', Aug: '08', Sep: '09', Oct: '10', Nov: '11', Dec: '12' }

/** « 29/Oct/2026:10:00:00 +0100 » → ISO 8601. */
export function clfTime(t: string): string | null {
  const m = /^(\d{2})\/(\w{3})\/(\d{4}):(\d{2}):(\d{2}):(\d{2}) ([+-])(\d{2})(\d{2})$/.exec(t)
  if (!m || !MONTHS[m[2]!]) return null
  const d = new Date(`${m[3]}-${MONTHS[m[2]!]}-${m[1]}T${m[4]}:${m[5]}:${m[6]}${m[7]}${m[8]}:${m[9]}`)
  return Number.isNaN(d.getTime()) ? null : d.toISOString()
}

const num = (v: unknown): number | null => {
  const n = typeof v === 'number' ? v : Number.parseFloat(String(v ?? ''))
  return Number.isFinite(n) ? n : null
}
const str = (v: unknown): string | null => (typeof v === 'string' && v && v !== '-' ? v : null)
/** « 0.012, 0.004 » (tentatives successives) → somme ; « - » → null. */
const upstreamTime = (v: unknown): number | null => {
  const parts = String(v ?? '').split(/[,:]\s*/).map(x => Number.parseFloat(x)).filter(Number.isFinite)
  return parts.length ? Math.round(parts.reduce((a, b) => a + b, 0) * 1000) / 1000 : null
}

function splitRequest(request: string): { method: string | null, path: string } {
  const m = /^([A-Z]+) (\S+)(?: HTTP\/[\d.]+)?$/.exec(request)
  return m ? { method: m[1]!, path: m[2]! } : { method: null, path: request || '-' }
}

// nginx-proxy (forego) : « nginx.1    | <ligne> ».
const FOREGO_RE = /^[\w-]+\.\d+\s+\|\s?/
const VHOST_RE = /^(\S+) (\S+) \S+ \S+ \[([^\]]+)\] "((?:[^"\\]|\\.)*)" (\d{3}) (\d+|-) "((?:[^"\\]|\\.)*)" "((?:[^"\\]|\\.)*)"(?: "([^"]*)")?/
const COMBINED_RE = /^(\S+) \S+ \S+ \[([^\]]+)\] "((?:[^"\\]|\\.)*)" (\d{3}) (\d+|-)(?: "((?:[^"\\]|\\.)*)" "((?:[^"\\]|\\.)*)")?/
const ERROR_RE = /^(\d{4}\/\d{2}\/\d{2} \d{2}:\d{2}:\d{2}) \[(\w+)\] \d+#\d+: (?:\*\d+ )?(.*)$/

export function parseAccessLine(raw: string): AccessEntry | null {
  const line = raw.replace(FOREGO_RE, '').trim()
  if (line.startsWith('{"platform":1')) {
    try {
      const j = JSON.parse(line) as Record<string, unknown>
      const status = num(j.status)
      if (status === null) return null
      const t = str(j.time) ? new Date(j.time as string) : null
      return {
        time: t && !Number.isNaN(t.getTime()) ? t.toISOString() : null,
        host: str(j.host)?.toLowerCase() ?? null,
        remote: str(j.remote),
        method: str(j.method),
        path: str(j.uri) ?? '-',
        status,
        bytes: num(j.bytes),
        duration: num(j.duration),
        upstream: str(j.upstream),
        upstreamTime: upstreamTime(j.upstreamTime),
        referer: str(j.referer),
        agent: str(j.agent),
        format: 'console',
      }
    }
    catch {
      return null
    }
  }
  const v = VHOST_RE.exec(line)
  // « vhost » : un domaine (ou une adresse) en tête, puis l'adresse du client.
  if (v && /^[\w.-]+(?::\d+)?$/.test(v[1]!) && /^[\d.:a-f]+$/i.test(v[2]!)) {
    const r = splitRequest(v[4]!)
    return { time: clfTime(v[3]!), host: v[1]!.replace(/:\d+$/, '').toLowerCase(), remote: v[2]!, ...r, status: Number(v[5]), bytes: num(v[6]), duration: null, upstream: str(v[9]), upstreamTime: null, referer: str(v[7]), agent: str(v[8]), format: 'vhost' }
  }
  const c = COMBINED_RE.exec(line)
  if (c) {
    const r = splitRequest(c[3]!)
    return { time: clfTime(c[2]!), host: null, remote: c[1]!, ...r, status: Number(c[4]), bytes: num(c[5]), duration: null, upstream: null, upstreamTime: null, referer: str(c[6]), agent: str(c[7]), format: 'combined' }
  }
  return null
}

export function parseErrorLine(raw: string): AccessError | null {
  const m = ERROR_RE.exec(raw.replace(FOREGO_RE, '').trim())
  if (!m) return null
  const t = new Date(m[1]!.replace(/\//g, '-').replace(' ', 'T'))
  return { time: Number.isNaN(t.getTime()) ? null : t.toISOString(), level: m[2]!, message: m[3]!.slice(0, 500), host: /host: "([^"]+)"/.exec(m[3]!)?.[1]?.toLowerCase() ?? null }
}

export const statusClass = (s: number): StatusClass => (s >= 200 && s < 300 ? '2xx' : s >= 300 && s < 400 ? '3xx' : s >= 400 && s < 500 ? '4xx' : s >= 500 && s < 600 ? '5xx' : 'other')

function quantile(sorted: number[], q: number): number | null {
  if (!sorted.length) return null
  return sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))]!
}

function top<T extends { requests: number }>(m: Map<string, T>, n: number): T[] {
  return [...m.values()].sort((a, b) => b.requests - a.requests).slice(0, n)
}

export function accessStats(entries: readonly AccessEntry[]): AccessStats {
  const status: AccessStats['status'] = { '2xx': 0, '3xx': 0, '4xx': 0, '5xx': 0, 'other': 0 }
  const durations: number[] = []
  const hosts = new Map<string, { host: string, requests: number, errors: number, d: number[] }>()
  const paths = new Map<string, { path: string, requests: number, errors: number }>()
  const remotes = new Map<string, { remote: string, requests: number }>()
  const minutes = new Map<string, { minute: string, requests: number, errors: number }>()
  let bytes = 0
  let first: string | null = null
  let last: string | null = null
  for (const e of entries) {
    const cls = statusClass(e.status)
    status[cls]++
    const err = cls === '5xx'
    bytes += e.bytes ?? 0
    if (e.duration !== null) durations.push(e.duration)
    if (e.host) {
      const h = hosts.get(e.host) ?? { host: e.host, requests: 0, errors: 0, d: [] }
      h.requests++
      if (err) h.errors++
      if (e.duration !== null) h.d.push(e.duration)
      hosts.set(e.host, h)
    }
    const p = e.path.split('?')[0]!.slice(0, 200)
    const pk = `${e.host ?? ''} ${p}`
    const pe = paths.get(pk) ?? { path: e.host ? `${e.host}${p}` : p, requests: 0, errors: 0 }
    pe.requests++
    if (err) pe.errors++
    paths.set(pk, pe)
    if (e.remote) remotes.set(e.remote, { remote: e.remote, requests: (remotes.get(e.remote)?.requests ?? 0) + 1 })
    if (e.time) {
      if (!first || e.time < first) first = e.time
      if (!last || e.time > last) last = e.time
      const minute = `${e.time.slice(0, 16)}:00.000Z`
      const m = minutes.get(minute) ?? { minute, requests: 0, errors: 0 }
      m.requests++
      if (err) m.errors++
      minutes.set(minute, m)
    }
  }
  durations.sort((a, b) => a - b)
  return {
    requests: entries.length,
    status,
    bytes,
    p50: quantile(durations, 0.5),
    p95: quantile(durations, 0.95),
    first,
    last,
    hosts: top(hosts, 20).map(h => ({ host: h.host, requests: h.requests, errors: h.errors, p95: quantile(h.d.sort((a, b) => a - b), 0.95) })),
    paths: top(paths, 10),
    remotes: top(remotes, 10),
    perMinute: [...minutes.values()].sort((a, b) => a.minute.localeCompare(b.minute)).slice(-120),
  }
}
