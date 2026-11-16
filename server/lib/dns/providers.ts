/**
 * API des fournisseurs DNS pour le défi ACME DNS-01 : liste des zones, ajout d'un enregistrement
 * TXT (_acme-challenge.<domaine>) puis retrait. Plusieurs valeurs peuvent coexister sous le même
 * nom (certificat *.domaine + domaine : deux défis). `fetch` injectable (tests).
 */
import { createHash, createHmac } from 'node:crypto'
import { type DnsCredentials, OVH_ENDPOINTS } from '../../../shared/schemas/dns'

type Fetch = typeof fetch

export interface DnsApi {
  zones(): Promise<string[]>
  /** Ajoute la valeur TXT ; renvoie la fonction qui la retire. */
  addTxt(fqdn: string, value: string): Promise<() => Promise<void>>
}

export interface DnsApiOptions {
  fetch?: Fetch
  now?: () => Date
  /** API Cloudflare (mandataire, banc de test). */
  cloudflareApi?: string
  sleep?: (ms: number) => Promise<void>
}

export class DnsApiError extends Error {}

/** Zone la plus précise couvrant le nom. */
export function zoneFor(fqdn: string, zones: readonly string[]): string | null {
  const n = fqdn.toLowerCase().replace(/\.$/, '')
  return [...zones].map(z => z.toLowerCase().replace(/\.$/, '')).filter(z => n === z || n.endsWith(`.${z}`)).sort((a, b) => b.length - a.length)[0] ?? null
}

const TIMEOUT = 20_000
const sha256 = (s: string) => createHash('sha256').update(s, 'utf8').digest('hex')
const hmac = (key: string | Buffer, s: string) => createHmac('sha256', key).update(s, 'utf8').digest()

// ---------------------------------------------------------------------------
// Cloudflare (jeton d'API : Zone.Zone:Read et Zone.DNS:Edit)
// ---------------------------------------------------------------------------

function cloudflare(token: string, o: Required<Pick<DnsApiOptions, 'fetch'>> & DnsApiOptions): DnsApi {
  const base = (o.cloudflareApi ?? 'https://api.cloudflare.com/client/v4').replace(/\/+$/, '')
  const call = async <T>(method: string, path: string, body?: unknown): Promise<T> => {
    const res = await o.fetch(`${base}${path}`, {
      method,
      headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(TIMEOUT),
    })
    const json = await res.json().catch(() => null) as { success?: boolean, errors?: { message: string }[], result?: T, result_info?: { total_pages?: number } } | null
    if (!res.ok || !json?.success) throw new DnsApiError(`Cloudflare : ${json?.errors?.map(e => e.message).join(', ') || `HTTP ${res.status}`}`)
    return Object.assign((json.result ?? {}) as object, { __info: json.result_info }) as T
  }
  const list = async () => {
    const out: { id: string, name: string }[] = []
    for (let page = 1; page <= 50; page++) {
      const r = await call<{ id: string, name: string }[] & { __info?: { total_pages?: number } }>('GET', `/zones?per_page=50&page=${page}`)
      out.push(...r.map(z => ({ id: z.id, name: z.name })))
      if (page >= (r.__info?.total_pages ?? 1)) break
    }
    return out
  }
  return {
    async zones() {
      return (await list()).map(z => z.name)
    },
    async addTxt(fqdn, value) {
      const zones = await list()
      const name = zoneFor(fqdn, zones.map(z => z.name))
      const zone = zones.find(z => z.name.toLowerCase() === name)
      if (!zone) throw new DnsApiError(`Cloudflare : aucune zone accessible pour ${fqdn}`)
      const rec = await call<{ id: string }>('POST', `/zones/${zone.id}/dns_records`, { type: 'TXT', name: fqdn, content: value, ttl: 60 })
      return async () => {
        await call('DELETE', `/zones/${zone.id}/dns_records/${rec.id}`)
      }
    },
  }
}

// ---------------------------------------------------------------------------
// OVHcloud (droits : GET /domain/zone, GET/POST/DELETE /domain/zone/*/record*, POST /domain/zone/*/refresh)
// ---------------------------------------------------------------------------

export function ovhSignature(applicationSecret: string, consumerKey: string, method: string, url: string, body: string, timestamp: number): string {
  return `$1$${createHash('sha1').update(`${applicationSecret}+${consumerKey}+${method}+${url}+${body}+${timestamp}`, 'utf8').digest('hex')}`
}

function ovh(c: Extract<DnsCredentials, { provider: 'ovh' }>, o: Required<Pick<DnsApiOptions, 'fetch'>> & DnsApiOptions): DnsApi {
  const base = OVH_ENDPOINTS[c.endpoint]
  let delta: number | null = null
  const call = async <T>(method: string, path: string, body?: unknown): Promise<T> => {
    if (delta === null) {
      const t = await o.fetch(`${base}/auth/time`, { signal: AbortSignal.timeout(TIMEOUT) })
      delta = Number(await t.text()) - Math.floor(Date.now() / 1000)
      if (!Number.isFinite(delta)) delta = 0
    }
    const url = `${base}${path}`
    const text = body === undefined ? '' : JSON.stringify(body)
    const ts = Math.floor(Date.now() / 1000) + delta
    const res = await o.fetch(url, {
      method,
      headers: {
        'Content-Type': 'application/json',
        'X-Ovh-Application': c.applicationKey,
        'X-Ovh-Consumer': c.consumerKey,
        'X-Ovh-Timestamp': String(ts),
        'X-Ovh-Signature': ovhSignature(c.applicationSecret, c.consumerKey, method, url, text, ts),
      },
      body: text || undefined,
      signal: AbortSignal.timeout(TIMEOUT),
    })
    const json = await res.json().catch(() => null) as (T & { message?: string }) | null
    if (!res.ok) throw new DnsApiError(`OVHcloud : ${json?.message ?? `HTTP ${res.status}`}`)
    return json as T
  }
  const zones = () => call<string[]>('GET', '/domain/zone')
  return {
    zones,
    async addTxt(fqdn, value) {
      const zone = zoneFor(fqdn, await zones())
      if (!zone) throw new DnsApiError(`OVHcloud : aucune zone accessible pour ${fqdn}`)
      const subDomain = fqdn.toLowerCase().replace(/\.$/, '').slice(0, -(zone.length + 1))
      const z = encodeURIComponent(zone)
      const rec = await call<{ id: number }>('POST', `/domain/zone/${z}/record`, { fieldType: 'TXT', subDomain, target: value, ttl: 60 })
      await call('POST', `/domain/zone/${z}/refresh`)
      return async () => {
        await call('DELETE', `/domain/zone/${z}/record/${rec.id}`)
        await call('POST', `/domain/zone/${z}/refresh`)
      }
    },
  }
}

// ---------------------------------------------------------------------------
// AWS Route 53 (signature v4 ; droits : route53:ListHostedZones, ListResourceRecordSets,
// ChangeResourceRecordSets, GetChange)
// ---------------------------------------------------------------------------

const enc = (s: string) => encodeURIComponent(s).replace(/[!'()*]/g, c => `%${c.charCodeAt(0).toString(16).toUpperCase()}`)

export function sigV4(input: { method: string, path: string, query: Record<string, string>, body: string, accessKeyId: string, secretAccessKey: string, now: Date, host?: string, region?: string, service?: string }) {
  const host = input.host ?? 'route53.amazonaws.com'
  const region = input.region ?? 'us-east-1'
  const service = input.service ?? 'route53'
  const amzDate = input.now.toISOString().replace(/[:-]|\.\d{3}/g, '')
  const date = amzDate.slice(0, 8)
  const payloadHash = sha256(input.body)
  const query = Object.keys(input.query).sort().map(k => `${enc(k)}=${enc(input.query[k]!)}`).join('&')
  const signedHeaders = 'host;x-amz-content-sha256;x-amz-date'
  const canonical = [input.method, input.path, query, `host:${host}\nx-amz-content-sha256:${payloadHash}\nx-amz-date:${amzDate}\n`, signedHeaders, payloadHash].join('\n')
  const scope = `${date}/${region}/${service}/aws4_request`
  const toSign = ['AWS4-HMAC-SHA256', amzDate, scope, sha256(canonical)].join('\n')
  const key = hmac(hmac(hmac(hmac(`AWS4${input.secretAccessKey}`, date), region), service), 'aws4_request')
  const signature = createHmac('sha256', key).update(toSign, 'utf8').digest('hex')
  return {
    url: `https://${host}${input.path}${query ? `?${query}` : ''}`,
    headers: {
      'x-amz-date': amzDate,
      'x-amz-content-sha256': payloadHash,
      'Authorization': `AWS4-HMAC-SHA256 Credential=${input.accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
    },
  }
}

const xmlAll = (xml: string, tag: string) => [...xml.matchAll(new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`, 'g'))].map(m => m[1]!)
const xmlOne = (xml: string, tag: string) => xmlAll(xml, tag)[0] ?? null
const xmlEsc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

function route53(c: Extract<DnsCredentials, { provider: 'route53' }>, o: Required<Pick<DnsApiOptions, 'fetch' | 'now' | 'sleep'>> & DnsApiOptions): DnsApi {
  const call = async (method: string, path: string, query: Record<string, string> = {}, body = ''): Promise<string> => {
    const s = sigV4({ method, path, query, body, accessKeyId: c.accessKeyId, secretAccessKey: c.secretAccessKey, now: o.now() })
    const res = await o.fetch(s.url, { method, headers: { ...s.headers, ...(body ? { 'Content-Type': 'application/xml' } : {}) }, body: body || undefined, signal: AbortSignal.timeout(TIMEOUT) })
    const text = await res.text()
    if (!res.ok) throw new DnsApiError(`Route 53 : ${xmlOne(text, 'Message') ?? `HTTP ${res.status}`}`)
    return text
  }
  const hosted = async () => {
    const out: { id: string, name: string }[] = []
    let marker: string | null = null
    for (let i = 0; i < 50; i++) {
      const xml = await call('GET', '/2013-04-01/hostedzone', { maxitems: '100', ...(marker ? { marker } : {}) })
      for (const z of xmlAll(xml, 'HostedZone')) {
        if (xmlOne(z, 'PrivateZone') === 'true') continue
        out.push({ id: xmlOne(z, 'Id')!.replace(/^\/hostedzone\//, ''), name: xmlOne(z, 'Name')!.replace(/\.$/, '') })
      }
      marker = xmlOne(xml, 'IsTruncated') === 'true' ? xmlOne(xml, 'NextMarker') : null
      if (!marker) break
    }
    return out
  }
  const current = async (zoneId: string, fqdn: string): Promise<string[]> => {
    const xml = await call('GET', `/2013-04-01/hostedzone/${zoneId}/rrset`, { name: `${fqdn}.`, type: 'TXT', maxitems: '1' })
    const set = xmlAll(xml, 'ResourceRecordSet').find(r => xmlOne(r, 'Name')?.replace(/\.$/, '').toLowerCase() === fqdn.toLowerCase() && xmlOne(r, 'Type') === 'TXT')
    return set ? xmlAll(set, 'Value') : []
  }
  const change = async (zoneId: string, fqdn: string, action: 'UPSERT' | 'DELETE', values: string[]) => {
    const records = values.map(v => `<ResourceRecord><Value>${xmlEsc(v)}</Value></ResourceRecord>`).join('')
    const body = `<?xml version="1.0" encoding="UTF-8"?><ChangeResourceRecordSetsRequest xmlns="https://route53.amazonaws.com/doc/2013-04-01/"><ChangeBatch><Changes><Change><Action>${action}</Action><ResourceRecordSet><Name>${fqdn}.</Name><Type>TXT</Type><TTL>60</TTL><ResourceRecords>${records}</ResourceRecords></ResourceRecordSet></Change></Changes></ChangeBatch></ChangeResourceRecordSetsRequest>`
    const xml = await call('POST', `/2013-04-01/hostedzone/${zoneId}/rrset`, {}, body)
    const id = xmlOne(xml, 'Id')?.replace(/^\/change\//, '')
    // Modification propagée sur les serveurs de Route 53 (INSYNC), 2 minutes au plus.
    for (let i = 0; id && i < 24; i++) {
      if (xmlOne(await call('GET', `/2013-04-01/change/${id}`), 'Status') === 'INSYNC') break
      await o.sleep(5000)
    }
  }
  return {
    async zones() {
      return (await hosted()).map(z => z.name)
    },
    async addTxt(fqdn, value) {
      const zones = await hosted()
      const name = zoneFor(fqdn, zones.map(z => z.name))
      const zone = zones.find(z => z.name.toLowerCase() === name)
      if (!zone) throw new DnsApiError(`Route 53 : aucune zone publique accessible pour ${fqdn}`)
      const quoted = `"${value}"`
      const before = await current(zone.id, fqdn)
      await change(zone.id, fqdn, 'UPSERT', [...before.filter(v => v !== quoted), quoted])
      return async () => {
        const now = await current(zone.id, fqdn)
        const rest = now.filter(v => v !== quoted)
        if (rest.length) await change(zone.id, fqdn, 'UPSERT', rest)
        else if (now.length) await change(zone.id, fqdn, 'DELETE', now)
      }
    },
  }
}

export function dnsApi(creds: DnsCredentials, opts: DnsApiOptions = {}): DnsApi {
  const o = { fetch: opts.fetch ?? fetch, now: opts.now ?? (() => new Date()), sleep: opts.sleep ?? ((ms: number) => new Promise<void>(r => setTimeout(r, ms))), cloudflareApi: opts.cloudflareApi }
  if (creds.provider === 'cloudflare') return cloudflare(creds.apiToken, o)
  if (creds.provider === 'ovh') return ovh(creds, o)
  return route53(creds, o)
}
