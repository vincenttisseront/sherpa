import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { covers, domainState, parseAcmeLogs, parseAcmeStore } from '../../server/lib/proxy/acme'
import { parseRepoUrl } from '../../shared/utils/github-url'

describe('URL de dépôt GitHub', () => {
  it.each([
    ['https://github.com/phpipam-docker/phpipam-docker', { repository: 'phpipam-docker/phpipam-docker', ref: null, path: null }],
    ['github.com/acme/shop.git', { repository: 'acme/shop', ref: null, path: null }],
    ['acme/shop', { repository: 'acme/shop', ref: null, path: null }],
    ['git@github.com:acme/shop.git', { repository: 'acme/shop', ref: null, path: null }],
    ['https://github.com/acme/shop/tree/main/deploy/prod', { repository: 'acme/shop', ref: 'main', path: 'deploy/prod', pathKind: 'dir' }],
    ['https://github.com/acme/shop/blob/v2.1/compose.yaml', { repository: 'acme/shop', ref: 'v2.1', path: 'compose.yaml', pathKind: 'file' }],
  ])('%s', (url, expected) => {
    expect(parseRepoUrl(url)).toMatchObject({ apiUrl: 'https://api.github.com', ...expected })
  })
  it('GitHub Enterprise : API /api/v3 de l\'hôte', () => {
    expect(parseRepoUrl('https://git.interne.fr/infra/ipam')).toMatchObject({ apiUrl: 'https://git.interne.fr/api/v3', repository: 'infra/ipam' })
  })
  it.each(['', 'https://github.com/', 'ftp://github.com/a/b', 'pas une url'])('refuse « %s »', (url) => {
    expect(parseRepoUrl(url)).toBeNull()
  })
})

describe('état ACME', () => {
  const dir = mkdtempSync(join(tmpdir(), 'acme-'))
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '60', '-subj', '/CN=(STAGING) Fake LE R3/O=(STAGING) Let\'s Encrypt', '-addext', 'subjectAltName=DNS:ipam.example.org,DNS:*.apps.example.org', '-keyout', join(dir, 'k.pem'), '-out', join(dir, 'c.pem')], { stdio: 'pipe' })
  const cert = readFileSync(join(dir, 'c.pem'), 'utf8')
  const store = JSON.stringify({
    le: {
      Account: { Email: 'ops@example.org', Registration: { uri: 'https://acme/acct/1' }, PrivateKey: 'CLE-PRIVEE-DU-COMPTE' },
      Certificates: [{ domain: { main: 'ipam.example.org', sans: ['*.apps.example.org'] }, certificate: Buffer.from(cert).toString('base64'), key: 'CLE-PRIVEE-DU-CERTIFICAT', Store: 'default' }],
    },
  })

  it('certificats : domaines, émetteur, expiration, autorité de test ; aucune clé conservée', () => {
    const s = parseAcmeStore(store, 'le')
    expect(s.accountRegistered).toBe(true)
    expect(s.certificates).toHaveLength(1)
    expect(s.certificates[0]).toMatchObject({ domains: ['ipam.example.org', '*.apps.example.org'], staging: true })
    expect(new Date(s.certificates[0]!.notAfter).getTime()).toBeGreaterThan(Date.now() + 50 * 864e5)
    expect(JSON.stringify(s)).not.toMatch(/CLE-PRIVEE|ops@example\.org/)
    expect(parseAcmeStore('{pas du json', 'le')).toEqual({ accountRegistered: false, certificates: [] })
  })

  it('joker d\'un seul niveau', () => {
    const c = parseAcmeStore(store, 'le').certificates[0]!
    expect(covers(c, 'shop.apps.example.org')).toBe(true)
    expect(covers(c, 'a.b.apps.example.org')).toBe(false)
    expect(covers(c, 'other.example.org')).toBe(false)
  })

  const logs = [
    '\u001B[90m2026-10-12T07:41:31Z\u001B[0m \u001B[31mERR\u001B[0m Unable to obtain ACME certificate for domains error="cannot get ACME client acme: error: 400 :: urn:ietf:params:acme:error:invalidContact :: contact email has invalid domain" ACME CA=https://acme-staging-v02.api.letsencrypt.org/directory domains=["phpipam.localhost"] providerName=le.acme',
    '2026-10-12T07:40:37Z INF Testing certificate renew... providerName=le.acme',
    '2026-10-12T07:40:38Z ERR Get "https://update.traefik.io/repos/traefik/traefik/releases": tls: failed to verify certificate',
    '2026-10-12T08:00:00Z ERR Error renewing certificate from LE: {shop.example.org []} error="403 :: urn:ietf:params:acme:error:unauthorized :: Invalid response" providerName=le.acme domains=["shop.example.org"]',
  ]

  it('erreurs des logs, par domaine, sans couleurs', () => {
    const e = parseAcmeLogs(logs)
    expect(e).toHaveLength(2)
    expect(e[0]).toMatchObject({ at: '2026-10-12T07:41:31Z', domains: ['phpipam.localhost'] })
    expect(e[0]!.message).toMatch(/invalidContact/)
    expect(e[1]!.domains).toEqual(['shop.example.org'])
  })

  it('état par domaine', () => {
    const s = parseAcmeStore(store, 'le')
    const e = parseAcmeLogs(logs)
    expect(domainState('ipam.example.org', s.certificates, e).state).toBe('valid')
    expect(domainState('phpipam.localhost', s.certificates, e)).toMatchObject({ state: 'error', certificate: null })
    expect(domainState('new.example.org', s.certificates, e).state).toBe('pending')
    expect(domainState('ipam.example.org', s.certificates, e, Date.now() + 50 * 864e5).state).toBe('expiring')
    expect(domainState('ipam.example.org', s.certificates, e, Date.now() + 70 * 864e5).state).toBe('expired')
  })
})
