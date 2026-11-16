import { describe, expect, it } from 'vitest'
import YAML from 'yaml'
import { type AnalyzeContext, analyzeCompose } from '../../server/lib/compose/analyze'
import { parseMount, parsePort } from '../../server/lib/compose/entries'
import { findVariables, interpolateValue } from '../../server/lib/compose/interpolate'

const ctx = (over: Partial<AnalyzeContext> = {}): AnalyzeContext => ({
  projectSlug: 'shop',
  projectId: 'p1',
  environmentKey: 'production',
  environmentId: 'e-prod',
  releaseSlug: 'r-0003-abcdef',
  composeDir: '',
  files: new Set(['Dockerfile', 'api/Dockerfile', 'compose.yml']),
  variables: {},
  portRules: [{ portFrom: 8000, portTo: 8099, protocol: 'tcp', policy: 'allowed' }],
  portApprovals: [],
  volumeRules: [{ hostPath: '/srv/shared/certs', mode: 'ro', environmentId: null, projectId: null, enabled: true }],
  runtimeDir: '/srv/apps-data/production/shop',
  workingRoots: ['/srv/deployments/production', '/srv/builds/production', '/srv/tmp/production'],
  networks: [
    { name: 'traefik-public', policy: 'allowed', allowedEnvironmentIds: [], missing: false },
    { name: 'legacy', policy: 'forbidden', allowedEnvironmentIds: [], missing: false },
    { name: 'dev-only', policy: 'allowed', allowedEnvironmentIds: ['e-dev'], missing: false },
  ],
  dockerVolumes: ['shared-cache'],
  ...over,
})

const codes = (r: ReturnType<typeof analyzeCompose>) => r.issues.filter(i => i.severity === 'error').map(i => i.code)

describe('entrées de ports et volumes', () => {
  it.each([
    ['80', { target: 80, published: null, hostIp: null, protocol: 'tcp' }],
    ['8080:80', { target: 80, published: 8080 }],
    ['127.0.0.1:8080:80/udp', { target: 80, published: 8080, hostIp: '127.0.0.1', protocol: 'udp' }],
    ['[::1]:8080:80', { hostIp: '::1', published: 8080 }],
    ['8000-8002:9000-9002', { published: 8000, publishedEnd: 8002, target: 9000, targetEnd: 9002 }],
  ])('analyse le port %s', (raw, expected) => {
    expect(parsePort(raw)).toMatchObject(expected)
  })
  it('accepte la syntaxe longue', () => {
    expect(parsePort({ target: 80, published: '8080', protocol: 'tcp', host_ip: '10.0.0.1' })).toMatchObject({ published: 8080, hostIp: '10.0.0.1' })
  })
  it.each(['0:80', '70000:80', '8000-9000:80', 'a:b', '8080:80/sctp'])('refuse le port %s', (raw) => {
    expect(() => parsePort(raw)).toThrow()
  })
  it('distingue bind, volume nommé et volume anonyme', () => {
    expect(parseMount('./data:/data:ro')).toMatchObject({ type: 'bind', source: './data', readOnly: true })
    expect(parseMount('pg:/var/lib/postgresql/data')).toMatchObject({ type: 'volume', source: 'pg' })
    expect(parseMount('/cache')).toMatchObject({ type: 'volume', source: null })
  })
})

describe('interpolation', () => {
  it('liste les variables et leur obligation', () => {
    expect(findVariables('a: ${A}\nb: ${B:-x}\nc: $C\nd: $${NOT}')).toEqual([
      { name: 'A', hasDefault: false, required: false },
      { name: 'B', hasDefault: true, required: false },
      { name: 'C', hasDefault: false, required: false },
    ])
  })
  it('échappe les $ des valeurs substituées et conserve $$', () => {
    const missing = new Set<string>()
    expect(interpolateValue('pw=${P} lit=$$x', { P: { value: 'a$b', secret: false } }, missing)).toBe('pw=a$$b lit=$$x')
  })
  it('applique les valeurs par défaut', () => {
    const missing = new Set<string>()
    expect(interpolateValue('${A:-def}|${B-def2}', { B: { value: '', secret: false } }, missing)).toBe('def|')
    expect(missing.size).toBe(0)
  })
})

describe('analyzeCompose', () => {
  const base = `
version: "3.9"
services:
  web:
    build: .
    container_name: shop_web
    ports: ["8080:80"]
    volumes:
      - ./uploads:/app/uploads
      - /srv/shared/certs:/certs:ro
    environment:
      DB_PASSWORD: \${DB_PASSWORD}
      MODE: \${MODE:-prod}
    networks: [front, traefik]
  db:
    image: postgres:17.2
    volumes: ["pg:/var/lib/postgresql/data"]
    networks: [front]
networks:
  front: {}
  traefik:
    external: true
    name: traefik-public
volumes:
  pg: {}
`
  const vars = { DB_PASSWORD: { value: 's3cr3t-value', secret: true } }

  it('accepte un Compose conforme et génère le Compose final', () => {
    const r = analyzeCompose(base, ctx({ variables: vars }))
    expect(codes(r)).toEqual([])
    expect(r.ok).toBe(true)
    expect(r.stackName).toBe('shop-production')
    const final = YAML.parse(r.finalYaml!)
    expect(final.version).toBeUndefined()
    expect(final.services.web).toMatchObject({ image: 'platform/shop-web:r-0003-abcdef', pull_policy: 'never', restart: 'unless-stopped' })
    expect(final.services.web.build).toBeUndefined()
    expect(final.services.web.container_name).toBeUndefined()
    expect(final.services.web.volumes[0]).toBe('/srv/apps-data/production/shop/uploads:/app/uploads')
    expect(final.services.web.labels['platform.release']).toBe('r-0003-abcdef')
    expect(r.builds).toEqual([{ service: 'web', context: '', dockerfile: 'Dockerfile', args: {}, target: null, image: 'platform/shop-web:r-0003-abcdef' }])
  })

  it('ne met jamais la valeur d\'une variable secrète dans le Compose final', () => {
    const r = analyzeCompose(base, ctx({ variables: vars }))
    expect(r.finalYaml).not.toContain('s3cr3t-value')
    expect(r.finalYaml).toContain('DB_PASSWORD: ${DB_PASSWORD}')
    expect(r.diff).not.toContain('s3cr3t-value')
    expect(r.secretVariables).toEqual(['DB_PASSWORD'])
    expect(YAML.parse(r.finalYaml!).services.web.environment.MODE).toBe('prod')
  })

  it('signale une variable sans valeur', () => {
    expect(codes(analyzeCompose(base, ctx()))).toContain('variable.missing')
  })

  it('présente un diff et la liste des modifications', () => {
    const r = analyzeCompose(base, ctx({ variables: vars }))
    expect(r.diff).toContain('-    build: .')
    expect(r.diff).toContain('+    image: platform/shop-web:r-0003-abcdef')
    expect(r.changes.map(c => c.kind)).toEqual(expect.arrayContaining(['build', 'container_name', 'restart', 'volume', 'label', 'removed', 'variable']))
  })

  it.each([
    ['privileged', 'privileged: true', 'service.privileged'],
    ['network_mode host', 'network_mode: host', 'service.network_host'],
    ['pid host', 'pid: host', 'service.pid_host'],
    ['SYS_ADMIN', 'cap_add: [SYS_ADMIN]', 'service.cap_add'],
    ['devices', 'devices: ["/dev/sda:/dev/sda"]', 'service.devices'],
    ['seccomp', 'security_opt: ["seccomp:unconfined"]', 'service.security_opt'],
    ['env_file', 'env_file: .env', 'service.env_file'],
    ['label Traefik manuel', 'labels: ["traefik.http.routers.x.rule=Host(`bank.example.com`)"]', 'labels.traefik'],
    ['label réservé', 'labels: { platform.project: autre }', 'labels.reserved'],
    ['socket Docker', 'volumes: ["/var/run/docker.sock:/var/run/docker.sock"]', 'volumes.refused'],
    ['bind hors liste blanche', 'volumes: ["/etc:/host-etc:ro"]', 'volumes.refused'],
    ['bind vers les sources', 'volumes: ["/srv/deployments/production/other:/x"]', 'volumes.refused'],
    ['remontée relative', 'volumes: ["../../etc:/x"]', 'volumes.refused'],
    ['port SSH', 'ports: ["22:22"]', 'ports.forbidden'],
    ['port aléatoire', 'ports: ["80"]', 'ports.random'],
    ['port sans règle non justifié', 'ports: ["9500:80"]', 'ports.approval'],
  ])('refuse : %s', (_label, line, code) => {
    const text = `services:\n  app:\n    image: nginx:1.27\n    ${line}\n`
    expect(codes(analyzeCompose(text, ctx()))).toContain(code)
  })

  it('accepte un port custom justifié et confirmé', () => {
    const text = 'services:\n  app:\n    image: nginx:1.27\n    ports: ["127.0.0.1:9500:80"]\n'
    const r = analyzeCompose(text, ctx({ portApprovals: [{ service: 'app', published: 9500, protocol: 'tcp', justification: 'Exposition du collecteur de métriques', confirmed: true }] }))
    expect(r.ok).toBe(true)
    expect(r.ports[0]).toMatchObject({ policy: 'approval', accepted: true })
  })

  it('refuse un secret utilisé hors environment', () => {
    const text = 'services:\n  app:\n    image: nginx:1.27\n    command: ["run", "${TOKEN}"]\n'
    expect(codes(analyzeCompose(text, ctx({ variables: { TOKEN: { value: 'x', secret: true } } })))).toContain('variable.secret_misuse')
  })

  it('contrôle les réseaux externes contre la politique de l\'endpoint', () => {
    const mk = (n: string) => `services:\n  app:\n    image: nginx:1.27\n    networks: [n]\nnetworks:\n  n:\n    external: true\n    name: ${n}\n`
    expect(codes(analyzeCompose(mk('legacy'), ctx()))).toContain('networks.refused')
    expect(codes(analyzeCompose(mk('dev-only'), ctx()))).toContain('networks.refused')
    expect(codes(analyzeCompose(mk('inexistant'), ctx()))).toContain('networks.refused')
    expect(analyzeCompose(mk('traefik-public'), ctx()).ok).toBe(true)
  })

  it('refuse un contexte de build qui sort des sources ou un Dockerfile absent', () => {
    expect(codes(analyzeCompose('services:\n  a:\n    build: ../..\n', ctx()))).toContain('build.context')
    expect(codes(analyzeCompose('services:\n  a:\n    build: https://github.com/x/y.git\n', ctx()))).toContain('build.context')
    expect(codes(analyzeCompose('services:\n  a:\n    build: { context: ., dockerfile: Other.Dockerfile }\n', ctx()))).toContain('build.dockerfile_missing')
    expect(codes(analyzeCompose('services:\n  a:\n    build: { context: ., dockerfile_inline: "FROM x" }\n', ctx()))).toContain('build.option')
  })

  it('résout le contexte relatif au répertoire du Compose', () => {
    const r = analyzeCompose('services:\n  api:\n    build: ./api\n', ctx({ composeDir: '', files: new Set(['api/Dockerfile']) }))
    expect(r.builds[0]?.context).toBe('api')
    const nested = analyzeCompose('services:\n  api:\n    build: .\n', ctx({ composeDir: 'api', files: new Set(['api/Dockerfile']) }))
    expect(nested.builds[0]?.context).toBe('api')
  })

  it('résiste aux bombes d\'alias YAML', () => {
    const bomb = `a: &a ["x","x","x","x","x","x","x","x","x"]\nb: &b [*a,*a,*a,*a,*a,*a,*a,*a,*a]\nc: &c [*b,*b,*b,*b,*b,*b,*b,*b,*b]\nd: &d [*c,*c,*c,*c,*c,*c,*c,*c,*c]\ne: &e [*d,*d,*d,*d,*d,*d,*d,*d,*d]\nf: &f [*e,*e,*e,*e,*e,*e,*e,*e,*e]\nservices: { x: { image: "a:1", command: *f } }\n`
    expect(codes(analyzeCompose(bomb, ctx()))).toContain('compose.yaml')
  })

  it('refuse include et les secrets de type fichier', () => {
    expect(codes(analyzeCompose('include: [other.yml]\nservices:\n  a:\n    image: nginx:1.27\n', ctx()))).toContain('compose.include')
    expect(codes(analyzeCompose('services:\n  a:\n    image: nginx:1.27\nsecrets:\n  s:\n    file: /etc/shadow\n', ctx()))).toContain('compose.secrets_file')
  })

  it('refuse un volume local qui masque un bind', () => {
    const text = 'services:\n  a:\n    image: nginx:1.27\n    volumes: ["v:/x"]\nvolumes:\n  v:\n    driver_opts: { type: none, o: bind, device: /etc }\n'
    expect(codes(analyzeCompose(text, ctx()))).toContain('volumes.refused')
  })

  it('écarte les services sous profil (ni construits, ni attendus)', () => {
    const r = analyzeCompose('services:\n  app:\n    image: nginx:1.27\n  seed:\n    build: ./seed\n    profiles: ["seed"]\n', ctx({ files: new Set() }))
    expect(r.ok).toBe(true)
    expect(r.services).toEqual(['app'])
    expect(r.builds).toEqual([])
    expect(YAML.parse(r.finalYaml!).services.seed).toBeUndefined()
  })

  it('avertit sur une image non figée', () => {
    const r = analyzeCompose('services:\n  a:\n    image: nginx\n', ctx())
    expect(r.ok).toBe(true)
    expect(r.issues.some(i => i.code === 'image.latest')).toBe(true)
  })
})

describe('services non gérés', () => {
  it('retirés du Compose final, dépendances et liens nettoyés, ports non évalués', () => {
    const r = analyzeCompose('services:\n  traefik:\n    image: traefik:v3.6\n    ports: ["80:80", "443:443"]\n  app:\n    image: nginx:1.27\n    depends_on: [traefik]\n    links: ["traefik:proxy"]\n', ctx({ excludedServices: ['traefik', 'absent'] }))
    const final = YAML.parse(r.finalYaml!) as { services: Record<string, { depends_on?: unknown, links?: unknown[] }> }
    expect(Object.keys(final.services)).toEqual(['app'])
    expect(final.services.app!.depends_on).toBeUndefined()
    expect(final.services.app!.links).toEqual([])
    expect(r.ports.some(p => p.service === 'traefik')).toBe(false)
    expect(r.issues.find(i => i.code === 'service.excluded')?.service).toBe('traefik')
    expect(r.issues.find(i => i.code === 'service.excluded_stale')?.service).toBe('absent')
  })

  it('network_mode partagé avec un service non géré : refusé', () => {
    const r = analyzeCompose('services:\n  vpn:\n    image: alpine:3.20\n  app:\n    image: nginx:1.27\n    network_mode: "service:vpn"\n', ctx({ excludedServices: ['vpn'] }))
    expect(r.issues.some(i => i.code === 'service.excluded_network')).toBe(true)
  })
})

describe('services suspendus', () => {
  it('retirés de la stack comme un service non géré, signalés comme suspendus', () => {
    const r = analyzeCompose('services:\n  varken:\n    image: boerderij/varken:1.0\n  app:\n    image: nginx:1.27\n    depends_on:\n      varken:\n        condition: service_started\n', ctx({ suspendedServices: ['varken'] }))
    const final = YAML.parse(r.finalYaml!) as { services: Record<string, { depends_on?: unknown }> }
    expect(Object.keys(final.services)).toEqual(['app'])
    expect(final.services.app!.depends_on).toBeUndefined()
    expect(r.services).toEqual(['app'])
    expect(r.issues.find(i => i.code === 'service.suspended')?.service).toBe('varken')
  })
})

describe('ports non publiés (reverse proxy uniquement)', () => {
  const compose = 'services:\n  web:\n    image: nginx:1.27\n    ports:\n      - "80:80"\n      - "8025:8025"\n  db:\n    image: postgres:16\n'
  it('port retiré du Compose final, gardé au rapport ; un port à valider ne bloque plus', () => {
    expect(codes(analyzeCompose(compose, ctx()))).toContain('ports.approval')
    const r = analyzeCompose(compose, ctx({ unpublishedPorts: [{ service: 'web', published: 80, protocol: 'tcp' }] }))
    expect(codes(r)).not.toContain('ports.approval')
    const final = YAML.parse(r.finalYaml!) as { services: Record<string, { ports?: string[] }> }
    expect(final.services.web!.ports).toEqual(['8025:8025'])
    expect(r.ports.find(p => p.published === 80)).toMatchObject({ unpublished: true, policy: 'internal', containerPort: 80 })
    expect(r.ports.find(p => p.published === 8025)).toMatchObject({ containerPort: 8025 })
    expect(r.changes.some(c => c.kind === 'port' && c.service === 'web')).toBe(true)
    expect(r.issues.find(i => i.code === 'ports.unpublished_unexposed')?.service).toBe('web')
  })
  it('dernier port retiré : clé ports supprimée ; pas d\'alerte si le service est exposé', () => {
    const r = analyzeCompose(compose, ctx({
      unpublishedPorts: [{ service: 'web', published: 80, protocol: 'tcp' }, { service: 'web', published: 8025, protocol: 'tcp' }],
      exposures: [{ service: 'web', host: 'shop.exemple.fr', port: 80, pathPrefix: null, middlewares: [] }],
      traefik: { networkName: 'traefik-public', certResolver: 'le', entrypointHttp: 'web', entrypointHttps: 'websecure', allowedDomains: ['*.exemple.fr'], defaultMiddlewares: [], routerNamePattern: '{project}-{env}-{service}', exposure: 'external', redirectToHttps: true },
    }))
    expect(codes(r)).toEqual([])
    const final = YAML.parse(r.finalYaml!) as { services: Record<string, { ports?: string[] }> }
    expect(final.services.web!.ports).toBeUndefined()
    expect(r.issues.some(i => i.code === 'ports.unpublished_unexposed')).toBe(false)
  })
  it('réglage d\'un autre service ou protocole : sans effet', () => {
    const r = analyzeCompose(compose, ctx({ unpublishedPorts: [{ service: 'db', published: 80, protocol: 'tcp' }, { service: 'web', published: 8025, protocol: 'udp' }], portApprovals: [{ service: 'web', published: 80, protocol: 'tcp', justification: 'Accès direct', confirmed: true }] }))
    const final = YAML.parse(r.finalYaml!) as { services: Record<string, { ports?: string[] }> }
    expect(final.services.web!.ports).toEqual(['80:80', '8025:8025'])
  })
})
