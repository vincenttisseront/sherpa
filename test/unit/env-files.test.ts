import { describe, expect, it } from 'vitest'
import YAML from 'yaml'
import { type AnalyzeContext, analyzeCompose } from '../../server/lib/compose/analyze'
import { envFileVarNames, looksSecret, parseDotenv } from '../../server/lib/compose/env-files'

describe('fichiers dotenv', () => {
  it('commentaires, export, guillemets, commentaire en fin de ligne', () => {
    expect(parseDotenv([
      '# commentaire',
      'DB_HOST=postgres',
      'export DB_USER=netbox',
      'SECRET_KEY="r(m)9nLGnz$(_q3N4z1k(EFsMCjjjzx08x9VhNVcfd%6RF#r!6DE@+V5Zk2X"',
      'EMPTY=',
      'QUOTED=\'a b\'',
      'TRAILING=value # note',
      'not a line',
    ].join('\n'))).toEqual([
      { key: 'DB_HOST', value: 'postgres' },
      { key: 'DB_USER', value: 'netbox' },
      { key: 'SECRET_KEY', value: 'r(m)9nLGnz$(_q3N4z1k(EFsMCjjjzx08x9VhNVcfd%6RF#r!6DE@+V5Zk2X' },
      { key: 'EMPTY', value: '' },
      { key: 'QUOTED', value: 'a b' },
      { key: 'TRAILING', value: 'value' },
    ])
  })

  it('même clé dans plusieurs fichiers : nom propre à chaque fichier suivant', () => {
    const m = envFileVarNames([
      { path: 'env/netbox.env', keys: ['DB_PASSWORD', 'REDIS_PASSWORD', 'REDIS_CACHE_PASSWORD'] },
      { path: 'env/postgres.env', keys: ['POSTGRES_PASSWORD'] },
      { path: 'env/redis.env', keys: ['REDIS_PASSWORD'] },
      { path: 'env/redis-cache.env', keys: ['REDIS_PASSWORD'] },
    ])
    expect(m.get('env/netbox.env')!.get('REDIS_PASSWORD')).toBe('REDIS_PASSWORD')
    expect(m.get('env/redis.env')!.get('REDIS_PASSWORD')).toBe('REDIS_REDIS_PASSWORD')
    expect(m.get('env/redis-cache.env')!.get('REDIS_PASSWORD')).toBe('REDIS_CACHE_REDIS_PASSWORD')
    expect(m.get('env/postgres.env')!.get('POSTGRES_PASSWORD')).toBe('POSTGRES_PASSWORD')
  })

  it('noms évoquant un secret', () => {
    for (const n of ['DB_PASSWORD', 'SECRET_KEY', 'API_TOKEN_PEPPER_1', 'SUPERUSER_API_TOKEN', 'SOCIAL_AUTH_OIDC_KEY']) expect(looksSecret(n)).toBe(true)
    for (const n of ['DB_HOST', 'EMAIL_PORT', 'REDIS_CACHE_DATABASE', 'SKIP_SUPERUSER']) expect(looksSecret(n)).toBe(false)
  })
})

const COMPOSE = `services:
  netbox: &netbox
    image: netboxcommunity/netbox:v4
    env_file: env/netbox.env
    environment:
      DB_HOST: db-override
    volumes:
      - ./configuration:/etc/netbox/config:z,ro
      - ./media:/opt/netbox/media
  netbox-worker:
    <<: *netbox
  redis-cache:
    image: valkey/valkey:9
    env_file: env/redis-cache.env
  other:
    image: busybox
    env_file: [{ path: env/optional.env, required: false }]
`
const files = new Set(['docker-compose.yml', 'env/netbox.env', 'env/redis-cache.env', 'configuration/configuration.py'])
const ctx = (over: Partial<AnalyzeContext> = {}): AnalyzeContext => ({
  projectSlug: 'netbox', projectId: 'p1', environmentKey: 'staging', environmentId: 'e1', releaseSlug: 'r-0001-aaaaaa', composeDir: '',
  files, variables: {}, portRules: [], portApprovals: [], volumeRules: [], runtimeDir: '/srv/apps-data/staging/netbox', workingRoots: ['/srv/deployments/staging'],
  networks: [], dockerVolumes: [], traefik: null, exposures: [], takenHosts: [],
  envFileKeys: { 'env/netbox.env': ['DB_HOST', 'DB_PASSWORD', 'REDIS_PASSWORD'], 'env/redis-cache.env': ['REDIS_PASSWORD'] },
  sourceDir: '/srv/deployments/staging/netbox/releases/r-0001-aaaaaa/source',
  ...over,
})

describe('env_file converti en variables de la plateforme', () => {
  it('variables manquantes regroupées par fichier (une seule action : l\'import)', () => {
    const r = analyzeCompose(COMPOSE, ctx())
    const errors = r.issues.filter(i => i.severity === 'error')
    expect(errors.map(e => e.code)).toEqual(['env_file.import', 'env_file.import'])
    expect(errors[0]!.message).toMatch(/2 variable\(s\) de env\/netbox\.env/)
    expect(errors[1]!.message).toMatch(/REDIS_CACHE_REDIS_PASSWORD/)
  })

  it('une fois importées : environment avec références, « environment » prioritaire, secrets jamais écrits', () => {
    const r = analyzeCompose(COMPOSE, ctx({ variables: {
      DB_PASSWORD: { value: 'p@ss', secret: true },
      REDIS_PASSWORD: { value: 'r1', secret: true },
      REDIS_CACHE_REDIS_PASSWORD: { value: 'r2', secret: true },
    } }))
    expect(r.issues.filter(i => i.severity === 'error')).toEqual([])
    const f = YAML.parse(r.finalYaml!)
    expect(f.services.netbox.env_file).toBeUndefined()
    expect(f.services.netbox.environment).toMatchObject({ DB_HOST: 'db-override', DB_PASSWORD: '${DB_PASSWORD}', REDIS_PASSWORD: '${REDIS_PASSWORD}' })
    expect(f.services['netbox-worker'].environment.DB_PASSWORD).toBe('${DB_PASSWORD}')
    expect(f.services['redis-cache'].environment).toEqual({ REDIS_PASSWORD: '${REDIS_CACHE_REDIS_PASSWORD}' })
    expect(f.services.other.env_file).toBeUndefined()
    expect(r.finalYaml).not.toMatch(/p@ss|r1|r2/)
  })

  it('fichiers des sources montés en lecture seule depuis la release, le reste dans les données', () => {
    const r = analyzeCompose(COMPOSE, ctx({ variables: { DB_PASSWORD: { value: 'x', secret: true }, REDIS_PASSWORD: { value: 'x', secret: true }, REDIS_CACHE_REDIS_PASSWORD: { value: 'x', secret: true } } }))
    const f = YAML.parse(r.finalYaml!)
    expect(f.services.netbox.volumes).toEqual([
      '/srv/deployments/staging/netbox/releases/r-0001-aaaaaa/source/configuration:/etc/netbox/config:z,ro',
      '/srv/apps-data/staging/netbox/media:/opt/netbox/media',
    ])
  })

  it('env_file absent des sources : bloquant', () => {
    const r = analyzeCompose('services:\n  a:\n    image: x\n    env_file: secrets.env\n', ctx())
    expect(r.issues.some(i => i.code === 'service.env_file' && /absent des sources/.test(i.message))).toBe(true)
  })
})
