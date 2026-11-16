import { describe, expect, it } from 'vitest'
import { hostsNeedingAcme, nginxCertFiles, nginxServedHosts, nginxSiteConfig as siteConfig, pickCertificate } from '../../server/lib/proxy/nginx-sites'
import YAML from 'yaml'
import { type AnalyzeContext, analyzeCompose } from '../../server/lib/compose/analyze'
import { isAllowedHost, matchesDomainPattern } from '../../shared/utils/domains'

describe('domaines autorisés', () => {
  it.each([
    ['shop.apps.exemple.fr', '*.apps.exemple.fr', true],
    ['SHOP.Apps.Exemple.fr.', '*.apps.exemple.fr', true],
    ['a.b.apps.exemple.fr', '*.apps.exemple.fr', false],
    ['apps.exemple.fr', '*.apps.exemple.fr', false],
    ['evilapps.exemple.fr', '*.apps.exemple.fr', false],
    ['shop.apps.exemple.fr.evil.com', '*.apps.exemple.fr', false],
    ['api.exemple.fr', 'api.exemple.fr', true],
    ['x.api.exemple.fr', 'api.exemple.fr', false],
  ])('%s vs %s → %s', (host, pattern, expected) => {
    expect(matchesDomainPattern(host, pattern)).toBe(expected)
  })
  it('aucun motif → rien n\'est autorisé', () => {
    expect(isAllowedHost('a.b.fr', [])).toBe(false)
  })
})

const tr = { networkName: 'edge', certResolver: 'le', entrypointHttp: 'web', entrypointHttps: 'websecure', allowedDomains: ['*.apps.exemple.fr'], defaultMiddlewares: ['secure-headers@file'], routerNamePattern: '{project}-{env}-{service}', exposure: 'internal' as const, redirectToHttps: true }
const ctx = (over: Partial<AnalyzeContext> = {}): AnalyzeContext => ({
  projectSlug: 'shop', projectId: 'p1', environmentKey: 'production', environmentId: 'e1', releaseSlug: 'r-0001-aaaaaa', composeDir: '',
  files: new Set(), variables: {}, portRules: [], portApprovals: [], volumeRules: [], runtimeDir: '/srv/apps-data/production/shop', workingRoots: [],
  networks: [{ name: 'edge', policy: 'allowed', allowedEnvironmentIds: [], missing: false }], dockerVolumes: [],
  traefik: tr,
  exposures: [{ service: 'web', host: 'shop.apps.exemple.fr', port: 8080, pathPrefix: null, middlewares: [] }],
  takenHosts: [],
  ...over,
})
const compose = 'services:\n  web:\n    image: nginx:1.27\n    networks: [back]\n  db:\n    image: postgres:17\n    networks: [back]\nnetworks:\n  back: {}\n'
const errors = (r: ReturnType<typeof analyzeCompose>) => r.issues.filter(i => i.severity === 'error').map(i => i.message)

describe('exposition Traefik', () => {
  it('génère les labels et raccorde le service au réseau Traefik sans perdre ses réseaux', () => {
    const r = analyzeCompose(compose, ctx())
    expect(errors(r)).toEqual([])
    const f = YAML.parse(r.finalYaml!)
    // Réseau partagé : alias unique « <stack>-<service> » sur le réseau propre.
    expect(f.services.web.networks).toEqual({ 'back': { aliases: ['shop-production-web'] }, 'platform-traefik': {} })
    expect(f.services.db.networks).toEqual({ back: { aliases: ['shop-production-db'] } })
    expect(f.networks['platform-traefik']).toEqual({ external: true, name: 'edge' })
    const l = f.services.web.labels
    expect(l['traefik.enable']).toBe('true')
    expect(l['traefik.docker.network']).toBe('edge')
    expect(l['traefik.http.routers.shop-production-web.rule']).toBe('Host(`shop.apps.exemple.fr`)')
    expect(l['traefik.http.routers.shop-production-web.tls.certresolver']).toBe('le')
    expect(l['traefik.http.routers.shop-production-web.middlewares']).toBe('secure-headers@file')
    expect(l['traefik.http.services.shop-production-web.loadbalancer.server.port']).toBe('8080')
    expect(l['traefik.http.middlewares.shop-production-web-https-redirect.redirectscheme.scheme']).toBe('https')
    expect(f.services.db.labels['traefik.enable']).toBeUndefined()
    expect(r.exposures[0]).toMatchObject({ accepted: true, url: 'https://shop.apps.exemple.fr' })
  })

  it('ajoute « default » quand le service n\'avait pas de réseau explicite', () => {
    const r = analyzeCompose('services:\n  web:\n    image: nginx:1.27\n', ctx())
    expect(YAML.parse(r.finalYaml!).services.web.networks).toEqual({ 'default': { aliases: ['shop-production-web'] }, 'platform-traefik': {} })
  })

  it('gère le préfixe de chemin et sert en HTTP sans redirection si configuré', () => {
    const r = analyzeCompose(compose, ctx({ traefik: { ...tr, redirectToHttps: false }, exposures: [{ service: 'web', host: 'shop.apps.exemple.fr', port: 80, pathPrefix: '/api', middlewares: [] }] }))
    const l = YAML.parse(r.finalYaml!).services.web.labels
    expect(l['traefik.http.routers.shop-production-web.rule']).toBe('Host(`shop.apps.exemple.fr`) && PathPrefix(`/api`)')
    expect(l['traefik.http.routers.shop-production-web-http.service']).toBe('shop-production-web')
  })

  it.each([
    ['domaine hors liste', { host: 'shop.autre.fr' }, /non autorisé/],
    ['sous-domaine à deux niveaux', { host: 'a.b.apps.exemple.fr' }, /non autorisé/],
    ['service inexistant', { service: 'nope' }, /absent/],
    ['port invalide', { port: 70000 }, /Port/],
    ['chemin invalide', { pathPrefix: 'api' }, /chemin/],
    ['middleware invalide', { middlewares: ['x;rm'] }, /middleware/],
    ['hôte invalide', { host: 'bad_host!.apps.exemple.fr' }, /invalide/],
  ])('refuse : %s', (_l, patch, re) => {
    const r = analyzeCompose(compose, ctx({ exposures: [{ service: 'web', host: 'shop.apps.exemple.fr', port: 8080, pathPrefix: null, middlewares: [], ...patch }] }))
    expect(errors(r).join('\n')).toMatch(re)
  })

  it('refuse un hôte déjà routé par un autre projet', () => {
    const r = analyzeCompose(compose, ctx({ takenHosts: [{ host: 'shop.apps.exemple.fr', pathPrefix: null, owner: 'autre-projet (staging)' }] }))
    expect(errors(r).join()).toMatch(/autre-projet/)
  })

  it('refuse sans Traefik configuré ou avec un réseau Traefik interdit', () => {
    expect(errors(analyzeCompose(compose, ctx({ traefik: null }))).join()).toMatch(/Aucun reverse proxy .* n'est configuré/)
    expect(errors(analyzeCompose(compose, ctx({ networks: [{ name: 'edge', policy: 'forbidden', allowedEnvironmentIds: [], missing: false }] }))).join()).toMatch(/non autorisé/)
  })

  it('refuse toujours les labels Traefik écrits à la main', () => {
    const r = analyzeCompose('services:\n  web:\n    image: nginx:1.27\n    labels: ["traefik.http.routers.x.rule=Host(`banque.fr`)"]\n', ctx({ exposures: [] }))
    expect(r.issues.some(i => i.code === 'labels.traefik')).toBe(true)
  })

  it('nomme distinctement deux routeurs du même service', () => {
    const r = analyzeCompose(compose, ctx({ traefik: { ...tr, allowedDomains: ['*.apps.exemple.fr'] }, exposures: [
      { service: 'web', host: 'a.apps.exemple.fr', port: 80, pathPrefix: null, middlewares: [] },
      { service: 'web', host: 'b.apps.exemple.fr', port: 80, pathPrefix: null, middlewares: [] },
    ] }))
    expect(r.exposures.map(e => e.router)).toEqual(['shop-production-web', 'shop-production-web-2'])
  })
})

describe('exposition nginx-proxy', () => {
  it('variables VIRTUAL_HOST / VIRTUAL_PORT / LETSENCRYPT_HOST, alias unique sur le réseau du proxy, aucun label Traefik', () => {
    const r = analyzeCompose(compose, ctx({ traefik: { ...tr, provider: 'nginx-proxy', letsencrypt: true }, exposures: [{ service: 'web', host: 'shop.apps.exemple.fr', port: 8080, pathPrefix: null, middlewares: ['x@file'] }, { service: 'web', host: 'boutique.apps.exemple.fr', port: 8080, pathPrefix: null, middlewares: [] }] }))
    expect(errors(r)).toEqual([])
    const f = YAML.parse(r.finalYaml!)
    expect(f.services.web.environment).toMatchObject({ VIRTUAL_HOST: 'shop.apps.exemple.fr,boutique.apps.exemple.fr', VIRTUAL_PORT: '8080', LETSENCRYPT_HOST: 'shop.apps.exemple.fr,boutique.apps.exemple.fr' })
    expect(f.services.web.networks['platform-traefik']).toEqual({ aliases: ['shop-production-web'] })
    expect(Object.keys(f.services.web.labels).some((k: string) => k.startsWith('traefik.'))).toBe(false)
    expect(r.issues.some(i => i.code === 'proxy.middlewares_ignored')).toBe(true)
  })

  it('un seul port par service ; chemin seulement pour une exposition unique ; HTTPS_METHOD sans redirection', () => {
    const two = analyzeCompose(compose, ctx({ traefik: { ...tr, provider: 'nginx-proxy' }, exposures: [{ service: 'web', host: 'a.apps.exemple.fr', port: 8080, pathPrefix: null, middlewares: [] }, { service: 'web', host: 'b.apps.exemple.fr', port: 9000, pathPrefix: null, middlewares: [] }] }))
    expect(errors(two).join()).toMatch(/un seul port exposé par service/)
    const path = analyzeCompose(compose, ctx({ traefik: { ...tr, provider: 'nginx-proxy', redirectToHttps: false }, exposures: [{ service: 'web', host: 'a.apps.exemple.fr', port: 8080, pathPrefix: '/app', middlewares: [] }] }))
    expect(YAML.parse(path.finalYaml!).services.web.environment).toMatchObject({ VIRTUAL_PATH: '/app', HTTPS_METHOD: 'noredirect' })
  })
})

describe('exposition nginx (conf.d)', () => {
  it('aucun label ni variable : alias unique sur le réseau du proxy, fichier annoncé', () => {
    const r = analyzeCompose(compose, ctx({ traefik: { ...tr, provider: 'nginx' } }))
    expect(errors(r)).toEqual([])
    const f = YAML.parse(r.finalYaml!)
    expect(f.services.web.networks['platform-traefik']).toEqual({ aliases: ['shop-production-web'] })
    expect(f.services.web.environment?.VIRTUAL_HOST).toBeUndefined()
    expect(r.changes.some(c => c.message.includes('platform-shop-production.conf'))).toBe(true)
  })

  it('fichier server { } : HTTP seul, ou TLS avec redirection ; proxy vers l\'alias résolu à la requête', async () => {
    const { nginxSiteConfig } = await import('../../server/lib/proxy/nginx-sites')
    const exp = [{ service: 'web', host: 'shop.apps.exemple.fr', port: 8080, pathPrefix: null }, { service: 'api', host: 'shop.apps.exemple.fr', port: 3000, pathPrefix: '/api' }]
    const http = nginxSiteConfig('shop-production', 'shop (production)', exp, { redirectToHttps: true, sslCertificate: null, sslCertificateKey: null })
    expect(http.match(/server \{/g)).toHaveLength(1)
    expect(http).toContain('listen 80;')
    expect(http).toContain('resolver 127.0.0.11')
    expect(http).toContain('set $platform_upstream http://shop-production-api:3000;')
    expect(http.indexOf('location /api {')).toBeLessThan(http.indexOf('location / {'))
    const tls = nginxSiteConfig('shop-production', 'shop (production)', exp, { redirectToHttps: true, sslCertificate: '/etc/nginx/certs/{host}.crt', sslCertificateKey: '/etc/nginx/certs/{host}.key' })
    expect(tls).toContain('return 301 https://$host$request_uri;')
    expect(tls).toContain('ssl_certificate /etc/nginx/certs/shop.apps.exemple.fr.crt;')
    expect(nginxSiteConfig('s', 'o', [], { redirectToHttps: true, sslCertificate: null, sslCertificateKey: null })).not.toContain('server {')
  })
})

describe('certificats nginx', () => {
  const now = Date.parse('2026-10-29T00:00:00Z')
  const cert = (domains: string[], days: number, isDefault = false) => ({ domains, notAfter: new Date(now + days * 864e5), isDefault })

  it('choisit le nom exact, puis le générique, puis le certificat par défaut', () => {
    const exact = cert(['app.ex.fr'], 60)
    const wild = cert(['*.ex.fr'], 300)
    const def = cert(['autre.fr'], 300, true)
    const all = [def, wild, exact]
    expect(pickCertificate(all, 'APP.ex.fr', now)).toBe(exact)
    expect(pickCertificate(all, 'api.ex.fr', now)).toBe(wild)
    expect(pickCertificate(all, 'a.b.ex.fr', now)).toBe(def)
    expect(pickCertificate([cert(['app.ex.fr'], -1)], 'app.ex.fr', now)).toBeNull()
    // Le plus lointain à égalité.
    const later = cert(['app.ex.fr'], 90)
    expect(pickCertificate([exact, later], 'app.ex.fr', now)).toBe(later)
  })

  it('nomme les fichiers par domaine', () => {
    expect(nginxCertFiles('/etc/nginx/platform-certs/', 'App.ex.fr')).toEqual({ certificate: '/etc/nginx/platform-certs/app.ex.fr.crt', key: '/etc/nginx/platform-certs/app.ex.fr.key' })
    expect(nginxCertFiles('/c', '*.ex.fr').certificate).toBe('/c/_wildcard.ex.fr.crt')
  })

  it('demande Let\'s Encrypt pour les domaines (génériques compris) sans certificat propre ou proches de l\'expiration', () => {
    const certs = [cert(['a.ex.fr'], 200), cert(['b.ex.fr'], 10), cert(['x.fr'], 300, true)]
    expect(hostsNeedingAcme(certs, ['a.ex.fr', 'b.ex.fr', 'c.ex.fr', '*.ex.fr', 'C.ex.fr'], now)).toEqual(['b.ex.fr', 'c.ex.fr', '*.ex.fr'])
  })

  it('renouvelle un certificat court au tiers de sa durée de vie', () => {
    const short = { domains: ['s.ex.fr'], notBefore: new Date(now - 5 * 864e5), notAfter: new Date(now + 2 * 864e5), isDefault: false }
    const fresh = { domains: ['f.ex.fr'], notBefore: new Date(now - 864e5), notAfter: new Date(now + 5 * 864e5), isDefault: false }
    expect(hostsNeedingAcme([short, fresh], ['s.ex.fr', 'f.ex.fr'], now)).toEqual(['s.ex.fr'])
  })

  it('lit les domaines servis dans les fichiers de sites de la console', () => {
    const conf = siteConfig('s', 'o', [{ service: 'web', host: 'a.ex.fr', port: 80, pathPrefix: null }], { redirectToHttps: false, sslCertificate: null, sslCertificateKey: null })
    expect(nginxServedHosts([{ path: '/etc/nginx/conf.d/platform-s.conf', content: conf }, { path: '/etc/nginx/conf.d/default.conf', content: 'server_name localhost;' }])).toEqual(['a.ex.fr'])
  })

  it('sert le défi ACME avant la redirection et le TLS par domaine', () => {
    const exp = [{ service: 'web', host: 'a.ex.fr', port: 80, pathPrefix: null }, { service: 'web', host: 'b.ex.fr', port: 80, pathPrefix: null }]
    const conf = siteConfig('s', 'o', exp, { redirectToHttps: true, sslCertificate: null, sslCertificateKey: null, tls: { 'a.ex.fr': { certificate: '/c/a.ex.fr.crt', key: '/c/a.ex.fr.key' } }, acmeWebroot: '/var/www/platform-acme' })
    const [a = '', b = ''] = conf.split('server_name b.ex.fr')
    expect(a).toContain('ssl_certificate /c/a.ex.fr.crt;')
    expect(a).toContain('location ^~ /.well-known/acme-challenge/ {')
    expect(a.indexOf('acme-challenge')).toBeLessThan(a.indexOf('return 301'))
    expect(a).not.toMatch(/^ {4}return 301/m)
    // b : pas encore de certificat, HTTP seul avec le défi.
    expect(b).not.toContain('443')
    expect(b).toContain('acme-challenge')
    expect(b).toContain('proxy_pass')
  })
})
