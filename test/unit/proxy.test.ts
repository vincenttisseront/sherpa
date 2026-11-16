import { describe, expect, it } from 'vitest'
import { flatFromArgs, flatFromEnv, flatten, parseConfigFile, parseToml } from '../../server/lib/proxy/flat'
import { caddyLabelRoutes, parseCaddyfile, parseNginx, parseUpstream, proxyKindOf } from '../../server/lib/proxy/others'
import { domainPatterns, proxyCandidates, suggestProxyConfig, suggestTraefikConfig } from '../../server/lib/proxy/suggest'
import { type ProbedProxy, type TopoContainer, buildTopology } from '../../server/lib/proxy/topology'
import { interpretDynamic, interpretStatic, parseRule, traefikArgs, versionFromImage } from '../../server/lib/proxy/traefik'
import { nginxSiteConfig } from '../../server/lib/proxy/nginx-sites'
import { buildProxyGraph } from '../../shared/utils/proxy-graph'

const TRAEFIK_YAML = `
entryPoints:
  web:
    address: ":80"
    http:
      redirections:
        entryPoint:
          to: websecure
          scheme: https
  websecure:
    address: ":443"
    http:
      tls:
        certResolver: le
      middlewares:
        - secure-headers@file
certificatesResolvers:
  le:
    acme:
      email: ops@example.org
      storage: /letsencrypt/acme.json
      dnsChallenge:
        provider: ovh
providers:
  docker:
    exposedByDefault: false
    network: edge
  file:
    directory: /etc/traefik/dynamic
api:
  dashboard: true
`

describe('configuration statique Traefik', () => {
  it('lit un fichier YAML : points d\'entrée, redirection, TLS, résolveur DNS, fournisseurs', () => {
    const st = interpretStatic(flatten(parseConfigFile('/etc/traefik/traefik.yml', TRAEFIK_YAML)), 'file', '/etc/traefik/traefik.yml')
    expect(st.entrypoints.map(e => [e.name, e.port, e.redirectTo, e.tls, e.certResolver])).toEqual([
      ['web', 80, 'websecure', false, null],
      ['websecure', 443, null, true, 'le'],
    ])
    expect(st.entrypoints[1]!.middlewares).toEqual(['secure-headers@file'])
    expect(st.certResolvers).toEqual([{ name: 'le', challenge: 'dns', dnsProvider: 'ovh', httpEntrypoint: null, staging: false, storage: '/letsencrypt/acme.json' }])
    expect(st.providers.docker).toMatchObject({ enabled: true, exposedByDefault: false, network: 'edge' })
    expect(st.providers.file).toMatchObject({ directory: '/etc/traefik/dynamic' })
    expect(st.api.dashboard).toBe(true)
    // L'e-mail ACME n'est jamais extrait.
    expect(JSON.stringify(st)).not.toContain('ops@example.org')
  })

  it('lit les arguments de lancement (et ignore le binaire)', () => {
    const args = traefikArgs(['/entrypoint.sh'], ['traefik', '--providers.docker=true', '--providers.docker.exposedbydefault=false', '--entrypoints.web.address=:80', '--entrypoints.websecure.address=:443', '--entrypoints.web.http.redirections.entrypoint.to=:443', '--certificatesresolvers.le.acme.httpchallenge.entrypoint=web', '--certificatesresolvers.le.acme.caserver=https://acme-staging-v02.api.letsencrypt.org/directory', '--api.insecure'])
    const st = interpretStatic(flatFromArgs(args), 'cli', null)
    expect(st.entrypoints.find(e => e.name === 'web')!.redirectTo).toBe('websecure')
    expect(st.certResolvers[0]).toMatchObject({ name: 'le', challenge: 'http', httpEntrypoint: 'web', staging: true })
    expect(st.providers.docker!.exposedByDefault).toBe(false)
    expect(st.api.insecure).toBe(true)
    expect(st.warnings.some(w => /test/.test(w))).toBe(true)
    expect(st.warnings.some(w => /sans authentification/.test(w))).toBe(true)
  })

  it('lit les variables TRAEFIK_*', () => {
    const st = interpretStatic(flatFromEnv({ TRAEFIK_ENTRYPOINTS_WEB_ADDRESS: ':80', TRAEFIK_PROVIDERS_DOCKER: 'true', PATH: '/bin' }), 'env', null)
    expect(st.entrypoints.map(e => e.name)).toEqual(['web'])
    expect(st.providers.docker!.exposedByDefault).toBe(true)
  })

  it('sans point d\'entrée déclaré : http sur :80', () => {
    const st = interpretStatic(new Map(), 'defaults', null)
    expect(st.entrypoints).toMatchObject([{ name: 'http', port: 80 }])
  })

  it('lit un fichier TOML', () => {
    const t = parseToml(`
# commentaire
[entryPoints]
  [entryPoints.web]
    address = ":80"
  [entryPoints.websecure]
    address = ":443"
    [entryPoints.websecure.http.tls]
      certResolver = "le"
[certificatesResolvers.le.acme]
  email = "x@y.z"
  [certificatesResolvers.le.acme.tlsChallenge]
[providers.docker]
  exposedByDefault = false
[[tls.certificates]]
  certFile = "/certs/a.crt"
  keyFile = "/certs/a.key"
[[tls.certificates]]
  certFile = "/certs/b.crt"
  keyFile = "/certs/b.key"
[http.routers.r1]
  rule = "Host(\`a.example.org\`)"
  entryPoints = ["websecure"]
  middlewares = ["auth"]
`)
    const st = interpretStatic(flatten(t), 'file', 'traefik.toml')
    expect(st.entrypoints.find(e => e.name === 'websecure')).toMatchObject({ tls: true, certResolver: 'le' })
    expect(st.certResolvers[0]!.challenge).toBe('tls')
    const d = interpretDynamic(flatten(t))
    expect(d.certificates.files).toBe(2)
    expect(d.routers[0]).toMatchObject({ name: 'r1', entrypoints: ['websecure'], middlewares: ['auth'] })
  })

  it('refuse un TOML mal formé avec la ligne', () => {
    expect(() => parseToml('a = \n[b')).toThrow(/ligne/)
  })

  it('version d\'après l\'image', () => {
    expect(versionFromImage('traefik:v3.5.1')).toBe('3.5.1')
    expect(versionFromImage('traefik:latest')).toBeNull()
  })
})

describe('règles de routage', () => {
  it.each([
    ['Host(`a.example.org`)', ['a.example.org'], null, true],
    ['Host(`a.example.org`) && PathPrefix(`/api`)', ['a.example.org'], '/api', true],
    ['Host(`a.example.org`) || Host(`b.example.org`)', ['a.example.org', 'b.example.org'], null, true],
    ['Host(`a.example.org`, `b.example.org`)', ['a.example.org', 'b.example.org'], null, true],
    ['HostRegexp(`{sub:[a-z]+}.example.org`)', [], null, false],
    ['Host(`a.example.org`) && Headers(`X`, `1`)', ['a.example.org'], null, false],
    ['Host(`a.example.org`) && !PathPrefix(`/x`)', ['a.example.org'], '/x', false],
    ['PathPrefix(`/x`)', [], '/x', false],
  ])('%s', (rule, hosts, path, simple) => {
    const r = parseRule(rule)
    expect(r.hosts).toEqual(hosts)
    expect(r.pathPrefix).toBe(path)
    expect(r.simple).toBe(simple)
  })
})

const c = (o: Partial<TopoContainer> & { id: string, name: string }): TopoContainer => ({ image: 'app:1', state: 'running', labels: {}, networks: [], ports: [], ...o })

describe('carte des expositions', () => {
  const traefik = c({ id: 't', name: 'traefik', image: 'traefik:v3.5', networks: ['edge'], ports: [{ ip: '0.0.0.0', privatePort: 443, publicPort: 443, type: 'tcp' }, { ip: '0.0.0.0', privatePort: 80, publicPort: 80, type: 'tcp' }] })
  const st = interpretStatic(flatten(parseConfigFile('t.yml', TRAEFIK_YAML)), 'file', 't.yml')
  const file = interpretDynamic(flatten(parseConfigFile('d.yml', `
http:
  routers:
    legacy:
      rule: Host(\`legacy.example.org\`)
      service: legacy
  services:
    legacy:
      loadBalancer:
        servers:
          - url: http://legacy-app:8080
  middlewares:
    secure-headers:
      headers:
        stsSeconds: 31536000
tls:
  options:
    modern:
      minVersion: VersionTLS13
`)))
  const shop = c({
    id: 's1', name: 'shop-web-1', networks: ['edge', 'shop_default'], ports: [{ ip: null, privatePort: 3000, publicPort: null, type: 'tcp' }],
    labels: {
      'com.docker.compose.project': 'shop', 'com.docker.compose.service': 'web',
      'traefik.enable': 'true',
      'traefik.http.routers.shop.rule': 'Host(`shop.example.org`)',
      'traefik.http.routers.shop.middlewares': 'shop-auth',
      'traefik.http.middlewares.shop-auth.basicauth.users': 'admin:$apr1$secret',
    },
  })
  const api = c({
    id: 'a1', name: 'api-1', networks: ['internal'], ports: [{ ip: null, privatePort: 8000, publicPort: null, type: 'tcp' }, { ip: null, privatePort: 9000, publicPort: null, type: 'tcp' }],
    labels: { 'com.docker.compose.project': 'api', 'com.docker.compose.service': 'api', 'traefik.enable': 'true', 'traefik.http.routers.api.rule': 'Host(`api.example.org`)' },
  })
  const legacy = c({ id: 'l1', name: 'legacy-app', networks: ['edge'] })
  const ignored = c({ id: 'i1', name: 'ignored', networks: ['edge'], labels: { 'traefik.http.routers.x.rule': 'Host(`x.example.org`)' } })
  const nginx = c({ id: 'n1', name: 'nginx', image: 'nginx:1.27', networks: ['edge'], ports: [{ ip: '0.0.0.0', privatePort: 80, publicPort: 8081, type: 'tcp' }] })
  const probes: ProbedProxy[] = [
    { kind: 'traefik', containerId: 't', static: st, dynamic: [file], sites: [], configFiles: ['t.yml', 'd.yml'], warnings: [] },
    { kind: 'nginx', containerId: 'n1', static: null, dynamic: [], sites: [{ site: 'old.example.org', hosts: ['old.example.org'], pathPrefix: null, tls: false, upstream: 'http://legacy-app:8080' }], configFiles: ['/etc/nginx/conf.d/old.conf'], warnings: [] },
  ]
  const topo = buildTopology('ep', [traefik, shop, api, legacy, ignored, nginx], probes)

  it('route docker : TLS hérité du point d\'entrée, résolveur, port implicite, réseau', () => {
    const r = topo.routes.find(x => x.router === 'shop@docker')!
    expect(r).toMatchObject({ hosts: ['shop.example.org'], tls: true, certResolver: 'le', targetPort: 3000, network: 'edge', convertible: true, entrypoints: ['web', 'websecure'] })
    expect(r.container).toMatchObject({ stack: 'shop', service: 'web' })
  })

  it('signale réseau absent et port indéterminé', () => {
    const r = topo.routes.find(x => x.router === 'api@docker')!
    expect(r.targetPort).toBeNull()
    expect(r.convertible).toBe(false)
    expect(r.warnings.join(' ')).toMatch(/Aucun réseau commun/)
    expect(r.warnings.join(' ')).toMatch(/Port de destination indéterminé/)
  })

  it('fournisseur fichier relié au conteneur, options TLS et middlewares sans leur contenu', () => {
    const r = topo.routes.find(x => x.router === 'legacy@file')!
    expect(r).toMatchObject({ targetUrl: 'http://legacy-app:8080', targetPort: 8080, network: 'edge' })
    expect(r.container?.name).toBe('legacy-app')
    const p = topo.proxies.find(x => x.kind === 'traefik')!
    expect(p.tlsOptions[0]).toMatchObject({ name: 'modern', minVersion: 'VersionTLS13' })
    expect(topo.middlewares).toContainEqual({ name: 'shop-auth@docker', type: 'basicauth', provider: 'shop-web-1' })
    expect(JSON.stringify(topo)).not.toContain('$apr1$')
  })

  it('labels ignorés sans traefik.enable, autres proxies signalés', () => {
    expect(topo.routes.some(r => r.hosts.includes('x.example.org'))).toBe(false)
    expect(topo.warnings.join(' ')).toMatch(/ignored : labels Traefik ignorés/)
    const n = topo.routes.find(r => r.provider === 'nginx')!
    expect(n.container?.name).toBe('legacy-app')
    expect(n.warnings[0]).toMatch(/hors plateforme/)
    expect(topo.proxies.find(p => p.kind === 'traefik')!.traefik!.entrypoints.find(e => e.name === 'websecure')!.hostPorts).toEqual(['0.0.0.0:443'])
  })

  it('propose une configuration Traefik à partir de l\'existant', () => {
    const s = suggestTraefikConfig(topo, [{ name: 'edge', policy: 'unreviewed', missing: false }])
    expect(s.config).toMatchObject({ networkName: 'edge', entrypointHttp: 'web', entrypointHttps: 'websecure', certResolver: 'le', exposure: 'external', redirectToHttps: true })
    expect(s.config!.allowedDomains).toEqual(expect.arrayContaining(['*.example.org']))
    expect(s.warnings.join(' ')).toMatch(/à autoriser/)
    expect(s.notes.redirectToHttps).toMatch(/point d'entrée web/)
  })

  it('conserve les domaines déjà autorisés et n\'ajoute que les hôtes non couverts', () => {
    const s = suggestTraefikConfig(topo, [{ name: 'edge', policy: 'allowed', missing: false }], ['*.example.org', 'intranet.local'])
    expect(s.config!.allowedDomains).toEqual(['*.example.org', 'intranet.local'])
    expect(s.notes.allowedDomains).toMatch(/déjà couverts/)
  })
})

describe('cas réels', () => {
  const traefik = c({ id: 't', name: 'traefik', image: 'traefik:v3.6', networks: ['edge'] })
  const st = interpretStatic(flatFromArgs(['--providers.docker=true', '--providers.docker.exposedbydefault=false', '--entrypoints.websecure.address=:443', '--entrypoints.websecure.http.tls=true']), 'cli', null)
  const app = (stack: string) => c({
    id: stack, name: `${stack}-api-1`, networks: ['edge'], ports: [{ ip: null, privatePort: 8080, publicPort: null, type: 'tcp' }],
    labels: { 'com.docker.compose.project': stack, 'com.docker.compose.service': 'api', 'traefik.enable': 'true', 'traefik.http.routers.ccx.rule': 'Host(`ccx.localhost`)', 'traefik.http.routers.ccx.middlewares': 'sec', 'traefik.http.middlewares.sec.headers.framedeny': 'true' },
  })
  const topo = buildTopology('ep', [traefik, app('demo'), app('wizard')], [{ kind: 'traefik', containerId: 't', static: st, dynamic: [], sites: [], configFiles: [], warnings: [] }])

  it('même routeur déclaré par deux stacks : signalé avec les destinations', () => {
    expect(topo.warnings.join(' ')).toMatch(/Routeur « ccx@docker » déclaré par plusieurs conteneurs \(ccx@docker → demo\/api, ccx@docker → wizard\/api\)/)
  })

  it('middleware défini par une application : jamais proposé par défaut', () => {
    const s = suggestTraefikConfig(topo, [{ name: 'edge', policy: 'allowed', missing: false }])
    expect(s.config!.defaultMiddlewares).toEqual([])
    expect(s.notes.defaultMiddlewares).toMatch(/définis par une application/)
  })

  it('destination ambiguë départagée par les réseaux du proxy', () => {
    const proxy = c({ id: 'p', name: 'proxy', image: 'caddy:2', networks: ['front'], ports: [{ ip: '0.0.0.0', privatePort: 443, publicPort: 443, type: 'tcp' }] })
    const a = c({ id: 'a', name: 'one-app-1', networks: ['front'], labels: { 'com.docker.compose.project': 'one', 'com.docker.compose.service': 'app' } })
    const b = c({ id: 'b', name: 'two-app-1', networks: ['back'], labels: { 'com.docker.compose.project': 'two', 'com.docker.compose.service': 'app' } })
    const t = buildTopology('ep', [proxy, a, b], [{ kind: 'caddy', containerId: 'p', static: null, dynamic: [], sites: [{ site: 'x.example.org', hosts: ['x.example.org'], pathPrefix: null, tls: true, upstream: 'app:3000' }], configFiles: [], warnings: [] }])
    expect(t.routes[0]!.container?.stack).toBe('one')
  })
})

describe('motifs de domaines', () => {
  it('localhost : joker accepté ; domaines existants conservés', () => {
    expect(domainPatterns(['a.localhost', 'b.localhost'])).toEqual(['*.localhost'])
    expect(domainPatterns(['example.org', 'foo.org'])).toEqual(['example.org', 'foo.org'])
  })

  it('regroupe par parent, garde les hôtes isolés exacts', () => {
    expect(domainPatterns(['a.apps.ex.fr', 'b.apps.ex.fr', 'solo.other.fr', 'ex.fr', '10.0.0.1'])).toEqual(['*.apps.ex.fr', 'ex.fr', 'solo.other.fr'])
  })
})

describe('autres proxies', () => {
  it('reconnaît les proxies, ignore un nginx applicatif', () => {
    expect(proxyKindOf('docker.io/library/traefik:v3.5', [])).toBe('traefik')
    expect(proxyKindOf('jc21/nginx-proxy-manager:2', [])).toBe('nginx-proxy-manager')
    expect(proxyKindOf('nginx:alpine', [])).toBeNull()
    expect(proxyKindOf('nginx:alpine', [443])).toBe('nginx')
    expect(proxyKindOf('caddy:2.10-alpine', [80])).toBe('caddy')
    expect(proxyKindOf('acme/traefik-exporter:1', [])).toBeNull()
  })

  it('nginx : sites, TLS et destinations', () => {
    const r = parseNginx(`
server {
  listen 443 ssl;
  server_name app.example.org www.example.org;
  ssl_certificate /etc/ssl/app.crt;
  location / { proxy_pass http://app:3000; }
  location /api/ { proxy_pass http://api:8000/; }
}
# server { listen 80; }
`)
    expect(r).toEqual([
      { site: 'app.example.org', hosts: ['app.example.org', 'www.example.org'], pathPrefix: null, tls: true, upstream: 'http://app:3000', listens: [443] },
      { site: 'app.example.org', hosts: ['app.example.org', 'www.example.org'], pathPrefix: '/api/', tls: true, upstream: 'http://api:8000/', listens: [443] },
    ])
  })

  it('Caddyfile : sites et reverse_proxy, bloc global ignoré', () => {
    const r = parseCaddyfile(`
{
  email ops@example.org
}
app.example.org, www.example.org {
  encode gzip
  reverse_proxy app:3000
}
http://plain.example.org {
  reverse_proxy @api api:8000
}
`)
    expect(r).toEqual([
      { site: 'app.example.org, www.example.org', hosts: ['app.example.org', 'www.example.org'], pathPrefix: null, tls: true, upstream: 'app:3000' },
      { site: 'http://plain.example.org', hosts: ['plain.example.org'], pathPrefix: null, tls: false, upstream: 'api:8000' },
    ])
  })

  it('Caddyfile : variable {$NOM:défaut} remplacée par sa valeur par défaut', () => {
    expect(parseCaddyfile('{$APP_DOMAIN:app.example.org} {\n  reverse_proxy app:3000\n}\n')[0]!.hosts).toEqual(['app.example.org'])
    expect(parseCaddyfile('{$APP_DOMAIN} {\n  reverse_proxy app:3000\n}\n')[0]!.hosts).toEqual([])
  })

  it('labels caddy-docker-proxy et destinations', () => {
    expect(caddyLabelRoutes({ 'caddy': 'a.example.org', 'caddy.reverse_proxy': '{{upstreams 8080}}' })).toEqual([{ hosts: ['a.example.org'], port: 8080 }])
    expect(parseUpstream('http://app:3000/x')).toEqual({ host: 'app', port: 3000 })
    expect(parseUpstream('$upstream')).toBeNull()
  })
})

describe('détection du reverse proxy', () => {
  const empty = { endpointId: 'e', scannedAt: '', proxies: [], routes: [], middlewares: [], warnings: [] }
  const ct = (name: string, image: string, ports: number[], extra: Partial<Parameters<typeof proxyCandidates>[1][number]> = {}) => ({
    id: `id-${name}`, name, image, running: true, networks: ['bridge', 'web'], probedKind: null,
    ports: ports.map(p => ({ ip: '0.0.0.0', privatePort: p, publicPort: p })), ...extra,
  })

  it('propose nginx classique pour un conteneur publiant 80/443 sans techno reconnue, après les proxies reconnus', () => {
    const list = proxyCandidates(empty, [ct('site', 'acme/site:1', [80]), ct('edge', 'openresty/openresty', [80, 443], { probedKind: 'nginx' }), ct('db', 'postgres', [5432])])
    expect(list.map(c => c.container)).toEqual(['edge', 'site'])
    expect(list[0]).toMatchObject({ kind: 'nginx', provider: 'nginx' })
    expect(list[1]).toMatchObject({ kind: null, provider: 'nginx' })
    expect(list[1]!.reason).toMatch(/reverse proxy ou site web/)
  })

  it('configure nginx-proxy avec acme-companion et le réseau autorisé', () => {
    const s = suggestProxyConfig(empty, [{ name: 'web', policy: 'allowed', missing: false }], ['*.ex.fr'], [
      ct('proxy', 'nginxproxy/nginx-proxy:1.6', [80, 443], { probedKind: null }),
      ct('acme', 'nginxproxy/acme-companion', []),
    ].map(c => ({ ...c })), undefined)
    // Sans topologie, nginx-proxy n'est reconnu que par la topologie : candidat inconnu → nginx proposé.
    expect(s.candidates![0]!.container).toBe('proxy')
    const topo = { ...empty, proxies: [{ kind: 'nginx-proxy' as const, container: { id: 'id-proxy', name: 'proxy', image: 'nginxproxy/nginx-proxy:1.6', stack: null, running: true }, version: null, networks: ['web'], hostPorts: [], traefik: null, tlsOptions: [], certificates: { files: 0, defaultCertificate: false }, configFiles: [], managedByPlatform: false, warnings: [] }] }
    const s2 = suggestProxyConfig(topo, [{ name: 'web', policy: 'allowed', missing: false }], ['*.ex.fr'], [ct('proxy', 'nginxproxy/nginx-proxy:1.6', [80, 443]), ct('acme', 'nginxproxy/acme-companion', [])])
    expect(s2.config).toMatchObject({ provider: 'nginx-proxy', nginxContainer: 'proxy', networkName: 'web', letsencrypt: true, redirectToHttps: true, exposure: 'external', allowedDomains: ['*.ex.fr'] })
    expect(s2.warnings).toEqual([])
  })

  it('choix explicite d\'un candidat, et aucun candidat', () => {
    const s = suggestProxyConfig(empty, [], [], [ct('a', 'caddy', [443], { probedKind: 'caddy' }), ct('b', 'x/y', [80])], 'b')
    expect(s.config).toMatchObject({ provider: 'nginx', nginxContainer: 'b', redirectToHttps: false })
    expect(s.candidates!.find(c => c.selected)!.container).toBe('b')
    const none = suggestProxyConfig(empty, [], [], [ct('db', 'postgres', [5432])])
    expect(none.available).toBe(false)
    expect(none.warnings[0]).toMatch(/aucun conteneur ne publie 80 ou 443/)
  })
})

describe('nginx présenté comme Traefik', () => {
  const site = nginxSiteConfig('shop-production', 'shop (production)', [{ service: 'web', host: 'shop.ex.fr', port: 3000, pathPrefix: null }], {
    redirectToHttps: true, sslCertificate: null, sslCertificateKey: null, tls: { 'shop.ex.fr': { certificate: '/c/shop.ex.fr.crt', key: '/c/shop.ex.fr.key' } }, acmeWebroot: '/var/www/platform-acme',
  })
  const hand = `
upstream legacy_pool { server legacy-app:8080; }
server {
  listen 80;
  server_name old.ex.fr;
  location / { proxy_pass http://legacy_pool; }
}
server {
  listen 0.0.0.0:8443 ssl;
  server_name intra.ex.fr;
  set $backend http://legacy-app:9000;
  location /api/ { proxy_pass $backend; }
}
`

  it('écoutes, redirection HTTPS, variable « set » et bloc upstream résolus', () => {
    const r = parseNginx(site, '/etc/nginx/conf.d/platform-shop-production.conf')
    expect(r).toContainEqual(expect.objectContaining({ hosts: ['shop.ex.fr'], redirect: true, listens: [80], tls: false, upstream: null }))
    expect(r).toContainEqual(expect.objectContaining({ hosts: ['shop.ex.fr'], tls: true, listens: [443], upstream: 'http://shop-production-web:3000', file: '/etc/nginx/conf.d/platform-shop-production.conf' }))
    const h = parseNginx(hand)
    expect(h).toContainEqual(expect.objectContaining({ hosts: ['old.ex.fr'], upstream: 'http://legacy-app:8080', listens: [80] }))
    expect(h).toContainEqual(expect.objectContaining({ hosts: ['intra.ex.fr'], pathPrefix: '/api/', upstream: 'http://legacy-app:9000', listens: [8443], tls: true }))
  })

  // Image personnalisée, déclarée comme reverse proxy des projets.
  const proxy = c({ id: 'bn', name: 'bastion-nginx', image: 'acme/bastion-pro-nginx:latest', networks: ['edge'], ports: [{ ip: '0.0.0.0', privatePort: 443, publicPort: 443, type: 'tcp' }, { ip: '0.0.0.0', privatePort: 80, publicPort: 80, type: 'tcp' }] })
  const shop = c({ id: 'sw', name: 'shop-production-web-1', networks: ['edge'], labels: { 'com.docker.compose.project': 'shop-production', 'com.docker.compose.service': 'web', 'platform.managed': 'true' } })
  const legacy = c({ id: 'lg', name: 'legacy-app', networks: ['legacy_default'], labels: { 'com.docker.compose.project': 'legacy', 'com.docker.compose.service': 'app' } })
  const managed = { provider: 'nginx' as const, confDir: '/etc/nginx/conf.d', certsDir: '/etc/nginx/platform-certs', acme: true, network: 'edge' }
  const sites = [...parseNginx(site, '/etc/nginx/conf.d/platform-shop-production.conf'), ...parseNginx(hand, '/etc/nginx/conf.d/legacy.conf')]
  const topo = buildTopology('ep', [proxy, shop, legacy], [{ kind: 'nginx', containerId: 'bn', static: null, dynamic: [], sites, configFiles: ['/etc/nginx/conf.d/legacy.conf', '/etc/nginx/conf.d/platform-shop-production.conf'], warnings: [], managed, certificateFiles: 2 }])

  it('proxy déclaré : écoutes, sites de la console, géré par la plateforme', () => {
    const p = topo.proxies[0]!
    expect(p.managedByPlatform).toBe(true)
    expect(p.nginx).toMatchObject({ managed, platformSites: 1, certificateFiles: 2 })
    expect(p.nginx!.listens).toEqual([
      { port: 80, tls: false, redirectTo: null, hostPorts: ['0.0.0.0:80'] },
      { port: 443, tls: true, redirectTo: null, hostPorts: ['0.0.0.0:443'] },
      { port: 8443, tls: true, redirectTo: null, hostPorts: [] },
    ])
  })

  it('site de la console : alias résolu vers le service, HTTPS redirigé, sans alerte', () => {
    const r = topo.routes.find(x => x.hosts.includes('shop.ex.fr') && x.tls)!
    expect(r).toMatchObject({ provider: 'nginx', entrypoints: [':443'], redirectsToHttps: true, targetPort: 3000, network: 'edge', convertible: false, warnings: [] })
    expect(r.container).toMatchObject({ stack: 'shop-production', service: 'web', managed: true })
    expect(topo.routes.find(x => x.hosts.includes('shop.ex.fr') && !x.tls)).toMatchObject({ redirectsToHttps: true, entrypoints: [':80'], warnings: [] })
  })

  it('site écrit à la main : reprenable, réseau à rejoindre signalé', () => {
    const r = topo.routes.find(x => x.hosts.includes('old.ex.fr'))!
    expect(r).toMatchObject({ convertible: true, targetPort: 8080, network: null, reattach: { network: 'edge' } })
    expect(r.warnings).toEqual(['Site défini hors plateforme (/etc/nginx/conf.d/legacy.conf)', 'Aucun réseau commun avec nginx : la route ne peut pas fonctionner'])
  })

  it('graphe : écoutes en points d\'entrée, URL HTTPS sur le port 443', () => {
    const map = { topology: topo, containers: [], resolvers: [], certificates: [], acmeErrors: [] }
    const g = buildProxyGraph(map, { proxyId: null, query: '', showDirect: false, showUnrouted: false })
    expect(g.proxies[0]!.entrypoints.map(e => e.name)).toEqual([':80', ':443', ':8443'])
    expect(g.urls.find(u => u.host === 'shop.ex.fr')!.url).toBe('https://shop.ex.fr')
  })

  it('nginx-proxy : sites lus dans VIRTUAL_HOST', () => {
    const np = c({ id: 'np', name: 'nginx-proxy', image: 'nginxproxy/nginx-proxy:1.6', networks: ['edge'], ports: [{ ip: '0.0.0.0', privatePort: 443, publicPort: 443, type: 'tcp' }] })
    const app = c({ id: 'ap', name: 'wiki-1', networks: ['edge'], ports: [{ ip: null, privatePort: 3000, publicPort: null, type: 'tcp' }], labels: { 'com.docker.compose.project': 'wiki', 'com.docker.compose.service': 'app' } })
    const t = buildTopology('ep', [np, app], [{ kind: 'nginx-proxy', containerId: 'np', static: null, dynamic: [], sites: [], configFiles: [], warnings: [], managed: { ...managed, provider: 'nginx-proxy', confDir: null }, virtualHosts: [{ containerId: 'ap', hosts: ['wiki.ex.fr'], port: null, path: null, httpsMethod: null }] }])
    expect(t.routes[0]).toMatchObject({ hosts: ['wiki.ex.fr'], tls: true, redirectsToHttps: true, targetPort: 3000, network: 'edge', convertible: true })
    expect(t.warnings.join(' ')).not.toMatch(/VIRTUAL_HOST/)
  })
})
