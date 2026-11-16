import { describe, expect, it } from 'vitest'
import { accountFor, acmePlan } from '../../server/lib/dns/acme-plan'
import { dnsApi, ovhSignature, sigV4, zoneFor } from '../../server/lib/dns/providers'

type Call = { url: string, method: string, body: string | null, headers: Record<string, string> }
function mockFetch(handler: (c: Call) => { status?: number, body: unknown }) {
  const calls: Call[] = []
  const f = (async (url: string, init: RequestInit = {}) => {
    const c = { url, method: init.method ?? 'GET', body: (init.body as string) ?? null, headers: (init.headers ?? {}) as Record<string, string> }
    calls.push(c)
    const r = handler(c)
    const text = typeof r.body === 'string' ? r.body : JSON.stringify(r.body)
    return new Response(text, { status: r.status ?? 200 })
  }) as unknown as typeof fetch
  return { f, calls }
}

describe('défi DNS-01 : plan et comptes', () => {
  const cf = { name: 'cf', zones: ['ex.fr'], wildcard: true }
  const sub = { name: 'sub', zones: ['int.ex.fr'], wildcard: false }

  it('choisit la zone la plus précise', () => {
    expect(zoneFor('_acme-challenge.a.int.ex.fr', ['ex.fr', 'int.ex.fr'])).toBe('int.ex.fr')
    expect(zoneFor('autre.fr', ['ex.fr'])).toBeNull()
    expect(accountFor([cf, sub], 'a.int.ex.fr')).toBe(sub)
    expect(accountFor([cf, sub], '*.app.ex.fr')).toBe(cf)
    expect(accountFor([cf, sub], 'x.org')).toBeNull()
  })

  it('certificat générique partagé, par nom, HTTP-01 ou refus', () => {
    expect(acmePlan('app.ex.fr', cf, true)).toEqual({ names: ['*.ex.fr', 'ex.fr'], method: 'dns-01' })
    expect(acmePlan('a.b.ex.fr', cf, true)).toEqual({ names: ['*.b.ex.fr', 'b.ex.fr'], method: 'dns-01' })
    // Le parent sortirait de la zone : certificat du nom seul.
    expect(acmePlan('ex.fr', cf, true)).toEqual({ names: ['ex.fr'], method: 'dns-01' })
    expect(acmePlan('a.int.ex.fr', sub, false)).toEqual({ names: ['a.int.ex.fr'], method: 'dns-01' })
    expect(acmePlan('*.app.ex.fr', cf, true)).toEqual({ names: ['*.app.ex.fr', 'app.ex.fr'], method: 'dns-01' })
    expect(acmePlan('app.x.org', null, true)).toEqual({ names: ['app.x.org'], method: 'http-01' })
    expect(acmePlan('*.x.org', null, true)).toHaveProperty('skip')
    expect(acmePlan('app.x.org', null, false)).toHaveProperty('skip')
  })
})

describe('fournisseurs DNS', () => {
  it('Cloudflare : zone trouvée, TXT créé puis retiré', async () => {
    const { f, calls } = mockFetch((c) => {
      if (c.url.includes('/zones?')) return { body: { success: true, result: [{ id: 'z1', name: 'ex.fr' }, { id: 'z2', name: 'autre.fr' }], result_info: { total_pages: 1 } } }
      if (c.method === 'POST') return { body: { success: true, result: { id: 'r1' } } }
      if (c.method === 'DELETE') return { body: { success: true, result: { id: 'r1' } } }
      return { status: 404, body: { success: false, errors: [{ message: 'not found' }] } }
    })
    const api = dnsApi({ provider: 'cloudflare', apiToken: 'jeton-de-test' }, { fetch: f })
    expect(await api.zones()).toEqual(['ex.fr', 'autre.fr'])
    const remove = await api.addTxt('_acme-challenge.app.ex.fr', 'valeur')
    const post = calls.find(c => c.method === 'POST')!
    expect(post.url).toBe('https://api.cloudflare.com/client/v4/zones/z1/dns_records')
    expect(JSON.parse(post.body!)).toEqual({ type: 'TXT', name: '_acme-challenge.app.ex.fr', content: 'valeur', ttl: 60 })
    expect(post.headers.Authorization).toBe('Bearer jeton-de-test')
    await remove()
    expect(calls.at(-1)).toMatchObject({ method: 'DELETE', url: 'https://api.cloudflare.com/client/v4/zones/z1/dns_records/r1' })
  })

  it('Cloudflare : erreur de l\'API remontée', async () => {
    const { f } = mockFetch(() => ({ status: 403, body: { success: false, errors: [{ message: 'Invalid API Token' }] } }))
    await expect(dnsApi({ provider: 'cloudflare', apiToken: 'jeton-de-test' }, { fetch: f }).zones()).rejects.toThrow('Cloudflare : Invalid API Token')
  })

  it('OVHcloud : requête signée, sous-domaine relatif à la zone, zone rafraîchie', async () => {
    const { f, calls } = mockFetch((c) => {
      if (c.url.endsWith('/auth/time')) return { body: String(Math.floor(Date.now() / 1000)) }
      if (c.url.endsWith('/domain/zone')) return { body: ['ex.fr'] }
      if (c.method === 'POST' && c.url.endsWith('/record')) return { body: { id: 42 } }
      return { body: null }
    })
    const api = dnsApi({ provider: 'ovh', endpoint: 'ovh-eu', applicationKey: 'ak-de-test', applicationSecret: 'as-de-test', consumerKey: 'ck-de-test' }, { fetch: f })
    const remove = await api.addTxt('_acme-challenge.app.ex.fr', 'valeur')
    const post = calls.find(c => c.method === 'POST' && c.url.endsWith('/record'))!
    expect(JSON.parse(post.body!)).toEqual({ fieldType: 'TXT', subDomain: '_acme-challenge.app', target: 'valeur', ttl: 60 })
    const ts = Number(post.headers['X-Ovh-Timestamp'])
    expect(post.headers['X-Ovh-Signature']).toBe(ovhSignature('as-de-test', 'ck-de-test', 'POST', post.url, post.body!, ts))
    expect(calls.some(c => c.url.endsWith('/domain/zone/ex.fr/refresh'))).toBe(true)
    await remove()
    expect(calls.some(c => c.method === 'DELETE' && c.url.endsWith('/domain/zone/ex.fr/record/42'))).toBe(true)
  })

  it('Route 53 : signature v4, valeurs existantes conservées, retrait de la seule valeur ajoutée', async () => {
    let values = ['"autre"']
    const { f, calls } = mockFetch((c) => {
      if (c.url.includes('/hostedzone?')) return { body: '<ListHostedZonesResponse><HostedZones><HostedZone><Id>/hostedzone/Z1</Id><Name>ex.fr.</Name><Config><PrivateZone>false</PrivateZone></Config></HostedZone></HostedZones><IsTruncated>false</IsTruncated></ListHostedZonesResponse>' }
      if (c.url.includes('/rrset?')) return { body: `<R><ResourceRecordSets><ResourceRecordSet><Name>_acme-challenge.app.ex.fr.</Name><Type>TXT</Type><ResourceRecords>${values.map(v => `<ResourceRecord><Value>${v}</Value></ResourceRecord>`).join('')}</ResourceRecords></ResourceRecordSet></ResourceRecordSets></R>` }
      if (c.method === 'POST') {
        values = [...c.body!.matchAll(/<Value>([^<]*)<\/Value>/g)].map(m => m[1]!)
        return { body: '<R><ChangeInfo><Id>/change/C1</Id><Status>PENDING</Status></ChangeInfo></R>' }
      }
      if (c.url.includes('/change/C1')) return { body: '<R><ChangeInfo><Status>INSYNC</Status></ChangeInfo></R>' }
      return { status: 400, body: '<E><Message>inattendu</Message></E>' }
    })
    const api = dnsApi({ provider: 'route53', accessKeyId: 'AKIDEXAMPLE00000', secretAccessKey: 'secret-de-test' }, { fetch: f, now: () => new Date('2026-10-29T10:00:00Z'), sleep: async () => {} })
    const remove = await api.addTxt('_acme-challenge.app.ex.fr', 'valeur')
    expect(values).toEqual(['"autre"', '"valeur"'])
    const post = calls.find(c => c.method === 'POST')!
    expect(post.url).toBe('https://route53.amazonaws.com/2013-04-01/hostedzone/Z1/rrset')
    expect(post.headers.Authorization).toMatch(/^AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE00000\/20261029\/us-east-1\/route53\/aws4_request, SignedHeaders=host;x-amz-content-sha256;x-amz-date, Signature=[0-9a-f]{64}$/)
    await remove()
    expect(values).toEqual(['"autre"'])
  })

  it('signature v4 déterministe, requête canonique triée', () => {
    const a = sigV4({ method: 'GET', path: '/2013-04-01/hostedzone', query: { maxitems: '100', marker: 'a b' }, body: '', accessKeyId: 'AK', secretAccessKey: 'S', now: new Date('2026-10-29T10:00:00Z') })
    const b = sigV4({ method: 'GET', path: '/2013-04-01/hostedzone', query: { marker: 'a b', maxitems: '100' }, body: '', accessKeyId: 'AK', secretAccessKey: 'S', now: new Date('2026-10-29T10:00:00Z') })
    expect(a).toEqual(b)
    expect(a.url).toBe('https://route53.amazonaws.com/2013-04-01/hostedzone?marker=a%20b&maxitems=100')
    expect(a.headers['x-amz-date']).toBe('20261029T100000Z')
  })
})
