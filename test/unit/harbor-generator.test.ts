import { describe, expect, it } from 'vitest'
import YAML from 'yaml'
import { adaptHarborCompose, detectHarborInstaller, harborPasswordProblem, patchHarborNginx, renderHarborConfig } from '../../server/lib/generators/harbor'

const TEMPLATE = `# Configuration file of Harbor
hostname: reg.mydomain.com
# http related config
http:
  port: 80
# https related config
https:
  port: 443
  certificate: /your/certificate/path
  private_key: /your/private/key/path
harbor_admin_password: Harbor12345
database:
  password: root123
  max_idle_conns: 100
data_volume: /data
log:
  level: info
  local:
    rotate_count: 50
    location: /var/log/harbor
_version: 2.15.0
`

// Extrait du Compose produit par prepare (data_volume et log_location déjà substitués).
const GENERATED = `services:
  log:
    image: goharbor/harbor-log:v2.15.4
    container_name: harbor-log
    volumes:
      - /srv/apps-data/staging/harbor/harbor/log/:/var/log/docker/:z
      - type: bind
        source: ./common/config/log/logrotate.conf
        target: /etc/logrotate.d/logrotate.conf
    ports:
      - 127.0.0.1:1514:10514
  core:
    image: goharbor/harbor-core:v2.15.4
    env_file:
      - ./common/config/core/env
    volumes:
      - /srv/apps-data/staging/harbor/harbor/data/:/data/:z
      - ./common/config/core/certificates/:/etc/core/certificates/:z
  postgresql:
    image: goharbor/harbor-db:v2.15.4
    env_file:
      - ./common/config/db/env
  proxy:
    image: goharbor/nginx-photon:v2.15.4
    volumes:
      - ./common/config/nginx:/etc/nginx:z
    ports:
      - 80:8080
`

describe('installateur Harbor', () => {
  it('détecte l\'installateur et la version de l\'image prepare', () => {
    const entries = ['harbor/prepare', 'harbor/install.sh', 'harbor/harbor.yml.tmpl', 'harbor/common.sh']
    const script = 'docker run --rm -v $input_dir:/input \\\n  goharbor/prepare:v2.15.4 prepare $@'
    expect(detectHarborInstaller(entries, 'harbor', script)).toMatchObject({ version: 'v2.15.4', prepareImage: 'goharbor/prepare:v2.15.4', templatePath: 'harbor/harbor.yml.tmpl' })
    expect(detectHarborInstaller(entries, 'harbor', 'docker run evil/image:latest')).toBeNull()
    expect(detectHarborInstaller(['compose.yml'], null, script)).toBeNull()
  })

  it('harbor.yml : HTTP derrière Traefik, URL publique HTTPS, chemins du projet, secrets', () => {
    const out = YAML.parse(renderHarborConfig(TEMPLATE, { hostname: 'harbor.example.org', externalUrl: 'https://harbor.example.org', adminPassword: 'Adm1nPassw0rd', dbPassword: 'DbPass123', dataVolume: '/srv/d', logLocation: '/srv/l' }))
    expect(out).toMatchObject({ hostname: 'harbor.example.org', external_url: 'https://harbor.example.org', harbor_admin_password: 'Adm1nPassw0rd', data_volume: '/srv/d', http: { port: 80 }, database: { password: 'DbPass123', max_idle_conns: 100 }, log: { local: { location: '/srv/l', rotate_count: 50 } } })
    expect(out.https).toBeUndefined()
    expect(() => renderHarborConfig(TEMPLATE, { hostname: 'pas un hôte', externalUrl: '', adminPassword: 'x', dbPassword: 'y', dataVolume: '/d', logLocation: '/l' })).toThrow(/Nom d'hôte invalide/)
  })

  it('règle des mots de passe Harbor', () => {
    expect(harborPasswordProblem('Harbor12345')).toBeNull()
    expect(harborPasswordProblem('court1A')).toMatch(/8 à 128/)
    expect(harborPasswordProblem('toutenminuscule1')).toMatch(/majuscule/)
  })

  it('Compose adapté : montages relatifs rendus absolus, env_file conservés, ports du proxy retirés', () => {
    const a = adaptHarborCompose(GENERATED, '/srv/apps-data/staging/harbor/harbor/prepare')
    const doc = YAML.parse(a.yaml)
    expect(doc.services.log.volumes[1].source).toBe('/srv/apps-data/staging/harbor/harbor/prepare/common/config/log/logrotate.conf')
    expect(doc.services.core.volumes[1]).toBe('/srv/apps-data/staging/harbor/harbor/prepare/common/config/core/certificates/:/etc/core/certificates/:z')
    expect(doc.services.core.volumes[0]).toBe('/srv/apps-data/staging/harbor/harbor/data/:/data/:z')
    expect(doc.services.proxy.volumes[0]).toBe('/srv/apps-data/staging/harbor/harbor/prepare/common/config/nginx:/etc/nginx:z')
    expect(doc.services.proxy.ports).toBeUndefined()
    // Le collecteur syslog reste publié en local : le démon Docker de l'hôte s'y connecte.
    expect(doc.services.log.ports).toEqual(['127.0.0.1:1514:10514'])
    expect(a.envFiles).toEqual(['common/config/core/env', 'common/config/db/env'])
    expect(doc.services.core.env_file).toEqual(['./common/config/core/env'])
  })
})

describe('nginx du proxy Harbor', () => {
  const conf = 'worker_processes auto;\nhttp {\n  tcp_nodelay on;\n  upstream core {\n    server core:8080;\n  }\n  upstream portal {\n    server portal:8080;\n  }\n}\n'
  it('résout core et portal en continu par le DNS de Docker', () => {
    const r = patchHarborNginx(conf)
    expect(r.changed).toBe(true)
    expect(r.conf).toContain('resolver 127.0.0.11 valid=10s ipv6=off;')
    expect(r.conf).toMatch(/upstream core \{\n {4}zone core 64k;\n {4}server core:8080 resolve;/)
    expect(r.conf).toContain('server portal:8080 resolve;')
  })
  it('ne réécrit pas une configuration déjà adaptée', () => {
    expect(patchHarborNginx(patchHarborNginx(conf).conf).changed).toBe(false)
  })
})
