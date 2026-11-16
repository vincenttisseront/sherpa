/**
 * Sonde réseau d'un conteneur, exécutée dans son espace réseau (conteneur jetable
 * « --network container:<id> ») : résolution des noms telle que le conteneur la voit, et temps de
 * réponse réel des URL de santé. Fonctions pures : noms à sonder, script, lecture du résultat.
 */

const HOST_RE = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$/i
const IPV4_RE = /^\d{1,3}(\.\d{1,3}){3}$/
const LOCAL = new Set(['localhost', 'ip6-localhost', 'ip6-loopback'])

export const PROBE_OUTPUT = '/tmp/probe.txt'
export const DNS_TIMEOUT_S = 5
export const HTTP_TIMEOUT_S = 30

/** Noms d'hôte cités par l'environnement d'un conteneur (URL de connexion, variables *_HOST). */
export function hostnamesFromEnv(env: string[]): string[] {
  const out = new Set<string>()
  for (const e of env) {
    const i = e.indexOf('=')
    if (i < 0) continue
    const name = e.slice(0, i)
    const value = e.slice(i + 1).trim()
    for (const m of value.matchAll(/[a-z][a-z0-9+.-]*:\/\/(?:[^@/\s]*@)?(\[[^\]]+\]|[^:/?#\s,]+)/gi)) out.add(m[1]!.toLowerCase())
    if (/(_HOST|_HOSTNAME|_SERVER)$/i.test(name) && HOST_RE.test(value)) out.add(value.toLowerCase())
  }
  return [...out].filter(h => HOST_RE.test(h) && !IPV4_RE.test(h) && !LOCAL.has(h))
}

/** URL HTTP(S) d'une commande de healthcheck (wget, curl…). */
export function httpUrlsOf(test: string[]): string[] {
  return [...new Set([...test.join(' ').matchAll(/https?:\/\/[^\s'"|;&)]+/g)].map(m => m[0]))]
}

const sh = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`

/** Script busybox : résultats dans PROBE_OUTPUT, chronométrés via /proc/uptime (centièmes de seconde). */
export function probeScript(names: string[], urls: string[]): string {
  const lines = [
    `out=${PROBE_OUTPUT}`,
    ': > "$out"',
    'now() { cut -d" " -f1 /proc/uptime; }',
  ]
  for (const n of names) {
    lines.push(`echo "@@DNS ${n}" >> "$out"; timeout ${DNS_TIMEOUT_S} nslookup ${sh(n)} >> "$out" 2>&1; echo "@@RC $?" >> "$out"`)
  }
  // URL mesurées en parallèle : une route bloquée ne retarde pas les autres.
  urls.forEach((u, i) => {
    lines.push(`( t0=$(now); timeout ${HTTP_TIMEOUT_S + 5} wget -q -O /dev/null -T ${HTTP_TIMEOUT_S} ${sh(u)} 2> /tmp/err${i}; rc=$?; t1=$(now); { echo "@@HTTP ${i} $rc $t0 $t1"; echo "@@ERR $(head -c 300 /tmp/err${i} | tr '\\n' ' ')"; } > /tmp/http${i} ) &`)
  })
  if (urls.length) lines.push('wait', ...urls.map((_, i) => `cat /tmp/http${i} >> "$out"`))
  return lines.join('\n')
}

export interface DnsAnswer { name: string, addresses: string[], status: 'ok' | 'not_found' | 'timeout' | 'error', detail?: string }
export interface HttpAnswer { url: string, exitCode: number, seconds: number | null, error: string }

export function parseProbe(text: string, names: string[], urls: string[]): { dns: DnsAnswer[], http: HttpAnswer[] } {
  const dns: DnsAnswer[] = []
  const http: HttpAnswer[] = []
  const lines = text.split('\n')
  let i = 0
  while (i < lines.length) {
    const l = lines[i++]!
    const d = l.match(/^@@DNS (\S+)$/)
    if (d) {
      const body: string[] = []
      let rc = 1
      while (i < lines.length) {
        const line = lines[i++]!
        const r = line.match(/^@@RC (\d+)$/)
        if (r) {
          rc = Number(r[1])
          break
        }
        body.push(line)
      }
      // Les lignes « Address: ip » sans port : réponses (celle du serveur DNS porte « :53 »).
      const addresses = [...new Set(body.map(b => b.match(/^Address(?: \d+)?:\s*(\d{1,3}(?:\.\d{1,3}){3})\s*$/)?.[1]).filter((a): a is string => !!a))]
      const text = body.join(' ')
      const status: DnsAnswer['status'] = addresses.length ? 'ok' : rc === 143 || rc === 124 ? 'timeout' : /NXDOMAIN|can't find|not found/i.test(text) ? 'not_found' : 'error'
      dns.push({ name: d[1]!, addresses, status, ...(status === 'error' ? { detail: text.replace(/\s+/g, ' ').trim().slice(0, 200) } : {}) })
      continue
    }
    const h = l.match(/^@@HTTP (\d+) (\d+) ([\d.]+) ([\d.]+)$/)
    if (h) {
      const err = (lines[i] ?? '').replace(/^@@ERR ?/, '').trim()
      http.push({ url: urls[Number(h[1])] ?? '?', exitCode: Number(h[2]), seconds: Math.max(0, Math.round((Number(h[4]) - Number(h[3])) * 100) / 100), error: err })
    }
  }
  // Noms jamais atteints (sonde interrompue) : signalés comme non mesurés.
  for (const n of names) if (!dns.some(x => x.name === n)) dns.push({ name: n, addresses: [], status: 'error', detail: 'non mesuré (sonde interrompue)' })
  urls.forEach((u) => {
    if (!http.some(x => x.url === u)) http.push({ url: u, exitCode: -1, seconds: null, error: 'non mesuré (sonde interrompue)' })
  })
  return { dns, http }
}

/** Valeurs de variables « secrètes » à ne pas masquer : identifiants publics (projet, services, images…). */
export function isBenignSecret(value: string, publicValues: Set<string>): boolean {
  const v = value.trim()
  // Booléens, nombres et niveaux de journal (LOG_LEVEL=error masquait « error » dans tous les messages).
  return publicValues.has(v) || /^(true|false|yes|no|on|off|\d+|trace|debug|info|notice|warn|warning|error|fatal|critical)$/i.test(v)
}
