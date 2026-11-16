import { parse } from 'yaml'
import { describe, expect, it } from 'vitest'
import type { ProxyRoute } from '../../shared/schemas/proxy'
import type { ContainerConfig } from '../../server/adapters/portainer/types'
import { convertCompose } from '../../server/lib/adoption/convert'
import { reconstructCompose } from '../../server/lib/adoption/reconstruct'

const route = (o: Partial<ProxyRoute>): ProxyRoute => ({
  router: 'r@docker', provider: 'docker', kind: 'http', rule: 'Host(`shop.example.org`)', hosts: ['shop.example.org'], pathPrefix: null, entrypoints: ['websecure'],
  tls: true, certResolver: 'le', tlsOptions: null, passthrough: false, redirectsToHttps: false, middlewares: [], service: null,
  container: { id: 'c1', name: 'shop-web-1', stack: 'shop', service: 'web', managed: false }, targetPort: 3000, targetUrl: null, network: 'edge', convertible: true, warnings: [],
  ...o,
})

const COMPOSE = `# Boutique
services:
  web:
    build: .
    environment:
      NODE_ENV: production
    labels:
      - traefik.enable=true
      - traefik.http.routers.shop.rule=Host(\`shop.example.org\`)
      - traefik.http.routers.shop.middlewares=shop-auth,secure@file
      - traefik.http.middlewares.shop-auth.basicauth.users=admin:x
      - com.example.team=web
    volumes:
      - ./uploads:/app/uploads
      - data:/app/data
    networks: [edge, back]
  db:
    image: postgres:17
    networks: [back]
networks:
  edge:
    external: true
  back: {}
volumes:
  data: {}
`

const ctx = {
  stackName: 'shop',
  traefikNetwork: 'edge',
  certResolver: 'le',
  routes: [
    route({}),
    route({ router: 'shop-http@docker', tls: false, redirectsToHttps: true }),
    route({ router: 'shop-admin@docker', rule: 'Host(`admin.example.org`) && Headers(`X`, `1`)', hosts: ['admin.example.org'], convertible: false }),
    route({ router: 'shop', middlewares: ['shop-auth', 'secure@file'], rule: 'Host(`www.example.org`)', hosts: ['www.example.org'] }),
  ],
  stackMiddlewares: new Map([['shop-auth', 'basicauth']]),
  foreignMiddlewareUsers: new Map<string, string[]>(),
  mounts: { web: [{ destination: '/app/uploads', source: '/data/compose/12/uploads' }] },
  runningImages: { web: 'shop-web:latest' },
}

describe('conversion d\'une stack existante', () => {
  const r = convertCompose(COMPOSE, ctx)
  const doc = parse(r.composeText) as { services: Record<string, Record<string, unknown>>, networks?: Record<string, unknown> }

  it('labels Traefik → expositions, middlewares de la stack écartés', () => {
    expect(r.exposures).toEqual([
      { service: 'web', host: 'shop.example.org', port: 3000, pathPrefix: null, middlewares: [] },
      { service: 'web', host: 'www.example.org', port: 3000, pathPrefix: null, middlewares: ['secure@file'] },
    ])
    expect(doc.services.web!.labels).toEqual(['com.example.team=web'])
    expect(r.notes.some(n => /shop-auth.*non repris/.test(n.message))).toBe(true)
  })

  it('route non convertible signalée et listée', () => {
    expect(r.droppedRoutes).toEqual(['admin.example.org → web'])
  })

  it('réseau Traefik retiré du service exposé et des réseaux déclarés', () => {
    expect(doc.services.web!.networks).toEqual(['back'])
    expect(doc.networks).toEqual({ back: {} })
  })

  it('bind relatif → chemin réel, build → image figée, environnement conservé', () => {
    expect(doc.services.web!.environment).toEqual({ NODE_ENV: 'production' })
    expect(doc.services.web!.volumes).toEqual(['/data/compose/12/uploads:/app/uploads', 'data:/app/data'])
    expect(doc.services.web!.build).toBeUndefined()
    expect(doc.services.web!.image).toBe('shop-web:latest')
    expect(r.composeText.startsWith('# Boutique')).toBe(true)
  })

  it('middleware utilisé par une autre stack : avertissement', () => {
    const r2 = convertCompose(COMPOSE, { ...ctx, foreignMiddlewareUsers: new Map([['shop-auth', ['blog@docker']]]) })
    expect(r2.notes.some(n => /utilisé ailleurs \(blog@docker\)/.test(n.message))).toBe(true)
  })

  it('env_file inconnu : bloquant', () => {
    const r3 = convertCompose('services:\n  a:\n    image: x\n    env_file: /srv/app.env\n', { ...ctx, routes: [] })
    expect(r3.notes.some(n => n.level === 'error' && /app\.env/.test(n.message))).toBe(true)
  })
})

const cfg = (o: Partial<ContainerConfig> & { id: string, name: string }): ContainerConfig => ({
  image: 'app:1', imageId: 'sha256:x', state: 'running', entrypoint: null, cmd: null, workingDir: null, user: null, env: [], labels: {},
  healthcheck: null, restartPolicy: 'unless-stopped', privileged: false, capAdd: [], capDrop: [], networkMode: 'legacy_default',
  portBindings: [], exposedPorts: [], mounts: [], networks: [], extraHosts: [], stopSignal: null, tty: false, ...o,
})

describe('reconstruction d\'un Compose à partir des conteneurs', () => {
  const r = reconstructCompose('legacy', [
    cfg({
      id: 'aaa', name: 'legacy-web-1', image: 'nginx:1.27', cmd: ['nginx', '-g', 'daemon off;'],
      env: ['PATH=/usr/bin', 'DB_PASSWORD=s3cr$t', 'MODE=prod'],
      labels: { 'com.docker.compose.project': 'legacy', 'com.docker.compose.service': 'web', 'com.docker.compose.depends_on': 'db:service_started:false', 'maintainer': 'NGINX', 'traefik.http.routers.w.rule': 'Host(`w.example.org`)', 'note': 'cost 5$' },
      portBindings: [{ container: '80/tcp', hostIp: '127.0.0.1', hostPort: '8080' }],
      mounts: [{ type: 'volume', source: null, destination: '/data', rw: true, name: 'legacy_data' }, { type: 'bind', source: '/srv/conf', destination: '/etc/nginx/conf.d', rw: false, name: null }, { type: 'volume', source: null, destination: '/cache', rw: true, name: 'a'.repeat(64) }],
      networks: [{ name: 'legacy_default', aliases: ['web', 'legacy-web-1'] }, { name: 'edge', aliases: ['www'] }],
    }),
    cfg({ id: 'bbb', name: 'legacy-db-1', image: 'postgres:17', env: ['DB_PASSWORD=other'], labels: { 'com.docker.compose.project': 'legacy', 'com.docker.compose.service': 'db' }, networks: [{ name: 'legacy_default', aliases: [] }] }),
    cfg({ id: 'ccc', name: 'legacy-web-run-1', labels: { 'com.docker.compose.project': 'legacy', 'com.docker.compose.service': 'web', 'com.docker.compose.oneoff': 'True' } }),
  ], {
    'nginx:1.27': { env: ['PATH=/usr/bin'], cmd: ['nginx', '-g', 'daemon off;'], entrypoint: null, workingDir: null, user: null, labels: { maintainer: 'NGINX' }, healthcheck: null },
    'postgres:17': null,
  })
  const doc = parse(r.composeText) as { services: Record<string, Record<string, unknown>>, volumes: Record<string, unknown>, networks: Record<string, unknown> }

  it('ne reprend que ce qui diffère de l\'image', () => {
    const web = doc.services.web!
    expect(web.command).toBeUndefined()
    expect(web.labels).toEqual({ 'traefik.http.routers.w.rule': 'Host(`w.example.org`)', 'note': 'cost 5$$' })
    expect(web.ports).toEqual(['127.0.0.1:8080:80'])
    expect(web.depends_on).toEqual(['db'])
    expect(web.restart).toBe('unless-stopped')
  })

  it('variables : références uniquement, conflits préfixés par le service', () => {
    // Services traités par ordre alphabétique : db garde le nom, web est préfixé.
    expect(doc.services.db!.environment).toEqual({ DB_PASSWORD: '${DB_PASSWORD}' })
    expect(doc.services.web!.environment).toEqual({ DB_PASSWORD: '${WEB_DB_PASSWORD}', MODE: '${MODE}' })
    expect(r.variables).toEqual({ DB_PASSWORD: 'other', WEB_DB_PASSWORD: 's3cr$t', MODE: 'prod' })
    expect(r.composeText).not.toContain('s3cr')
  })

  it('volumes et réseaux : noms courts de la stack, externes sinon, anonymes signalés', () => {
    expect(doc.services.web!.volumes).toEqual(['data:/data', '/srv/conf:/etc/nginx/conf.d:ro'])
    expect(doc.volumes).toEqual({ data: {} })
    expect(doc.services.web!.networks).toEqual({ default: null, edge: { aliases: ['www'] } })
    expect(doc.networks).toEqual({ edge: { external: true, name: 'edge' } })
    expect(doc.services.db!.networks).toBeUndefined()
    expect(r.notes.some(n => /Volume anonyme/.test(n.message))).toBe(true)
    expect(Object.keys(doc.services)).toEqual(['db', 'web'])
  })
})

describe('reprise : port publié remplacé par une exposition web', () => {
  const compose = [
    'services:',
    '  proxy:',
    '    image: caddy:2',
    '    ports:',
    '      - "127.0.0.1:4080:80"',
    '      - "8443:443/tcp"',
    '  db:',
    '    image: postgres:16',
    '    ports:',
    '      - target: 5432',
    '        published: 54320',
    '        protocol: tcp',
    '',
  ].join('\n')

  it('retire seulement les ports choisis (syntaxes courte et longue)', async () => {
    const { dropPublishedPorts } = await import('../../server/lib/adoption/convert')
    const r = dropPublishedPorts(compose, [{ service: 'proxy', published: 4080, protocol: 'tcp' }, { service: 'db', published: 54320, protocol: 'tcp' }])
    expect(r.removed).toHaveLength(2)
    expect(r.composeText).not.toContain('4080')
    expect(r.composeText).toContain('8443:443/tcp')
    // Plus aucun port publié pour db : la clé est retirée.
    const out = parse(r.composeText) as { services: Record<string, { ports?: unknown[] }> }
    expect(out.services.db!.ports).toBeUndefined()
    expect(out.services.proxy!.ports).toEqual(['8443:443/tcp'])
  })

  it('ignore un port d\'un autre service ou d\'un autre protocole', async () => {
    const { dropPublishedPorts } = await import('../../server/lib/adoption/convert')
    const r = dropPublishedPorts(compose, [{ service: 'db', published: 4080, protocol: 'tcp' }, { service: 'proxy', published: 4080, protocol: 'udp' }])
    expect(r.removed).toEqual([])
    expect(r.composeText).toContain('127.0.0.1:4080:80')
  })
})

describe('reprise d\'une stack détachée de la plateforme', () => {
  const base = { 'com.docker.compose.project': 'shop', 'platform.managed': 'true', 'platform.project': 'shop', 'platform.release': 'r-0001-aaaaaa' }
  const r = reconstructCompose('shop', [
    cfg({ id: 'w', name: 'shop-web-1', image: 'nginx:1.27', labels: { ...base, 'com.docker.compose.service': 'web', 'com.centurylinklabs.watchtower.enable': 'true', 'keep': 'me' } }),
    cfg({ id: 't', name: 'shop-platform-watchtower-1', image: 'nickfedor/watchtower:1.23.0', labels: { ...base, 'com.docker.compose.service': 'platform-watchtower' } }),
  ], {})
  const doc = parse(r.composeText) as { services: Record<string, { labels?: Record<string, string> }> }

  it('labels de la plateforme et Watchtower de la plateforme écartés, le reste conservé', () => {
    expect(Object.keys(doc.services)).toEqual(['web'])
    expect(doc.services.web!.labels).toEqual({ keep: 'me' })
  })
})
