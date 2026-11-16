import { describe, expect, it } from 'vitest'
import { hostnamesFromEnv, httpUrlsOf, isBenignSecret, parseProbe, probeScript } from '../../server/lib/network-probe'

describe('sonde réseau', () => {
  it('hôtes cités par l\'environnement (URL de connexion, *_HOST), jamais les identifiants', () => {
    expect(hostnamesFromEnv([
      'DATABASE_URL=postgres://app:s3cret@postgres:5432/app',
      'REDIS_URL=redis://:pw@redis:6379/0',
      'SMTP_HOST=mail.example.com',
      'API=http://127.0.0.1:8080/x',
      'SELF=http://localhost:3000',
      'MODE=demo',
    ]).sort()).toEqual(['mail.example.com', 'postgres', 'redis'])
  })

  it('URL d\'un healthcheck', () => {
    expect(httpUrlsOf(['CMD-SHELL', 'wget -qO- http://127.0.0.1:3000/api/health || wget -qO- http://127.0.0.1:3000/ || exit 1']))
      .toEqual(['http://127.0.0.1:3000/api/health', 'http://127.0.0.1:3000/'])
    expect(httpUrlsOf(['CMD', 'pg_isready'])).toEqual([])
  })

  it('script : noms et URL échappés pour le shell', () => {
    const s = probeScript(['redis'], ['http://x/?a=\'b'])
    expect(s).toContain('nslookup \'redis\'')
    expect(s).toContain('\'http://x/?a=\'\\\'\'b\'')
  })

  it('lecture : réponses, introuvable, délai, HTTP chronométré', () => {
    const out = [
      '@@DNS postgres',
      'Server:\t\t127.0.0.11',
      'Address:\t127.0.0.11:53',
      '',
      'Non-authoritative answer:',
      'Name:\tpostgres',
      'Address: 10.210.0.3',
      'Name:\tpostgres',
      'Address: 172.18.0.9',
      '@@RC 0',
      '@@DNS nope',
      '** server can\'t find nope: NXDOMAIN',
      '@@RC 1',
      '@@DNS slow',
      '@@RC 143',
      '@@HTTP 0 143 100.10 135.12',
      '@@ERR ',
      '@@HTTP 1 1 200.00 200.05',
      '@@ERR wget: server returned error: HTTP/1.1 503 Service Unavailable',
    ].join('\n')
    const r = parseProbe(out, ['postgres', 'nope', 'slow'], ['http://a/health', 'http://a/'])
    expect(r.dns).toEqual([
      { name: 'postgres', addresses: ['10.210.0.3', '172.18.0.9'], status: 'ok' },
      { name: 'nope', addresses: [], status: 'not_found' },
      { name: 'slow', addresses: [], status: 'timeout' },
    ])
    expect(r.http).toEqual([
      { url: 'http://a/health', exitCode: 143, seconds: 35.02, error: '' },
      { url: 'http://a/', exitCode: 1, seconds: 0.05, error: 'wget: server returned error: HTTP/1.1 503 Service Unavailable' },
    ])
  })

  it('sonde interrompue : mesures manquantes signalées', () => {
    const r = parseProbe('', ['redis'], ['http://a/'])
    expect(r.dns[0]).toMatchObject({ name: 'redis', status: 'error' })
    expect(r.http[0]).toMatchObject({ exitCode: -1, seconds: null })
  })

  it('valeurs secrètes publiques non masquées', () => {
    const pub = new Set(['edutis'])
    expect(isBenignSecret('edutis', pub)).toBe(true)
    expect(isBenignSecret('true', pub)).toBe(true)
    expect(isBenignSecret('3000', pub)).toBe(true)
    expect(isBenignSecret('error', pub)).toBe(true)
    expect(isBenignSecret('Zk8-secret', pub)).toBe(false)
  })
})
