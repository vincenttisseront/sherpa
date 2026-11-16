import { describe, expect, it } from 'vitest'
import YAML from 'yaml'
import { type AnalyzeContext, WATCHTOWER_REPORT_TEMPLATE, WATCHTOWER_SERVICE, analyzeCompose, watchtowerPolicyOf } from '../../server/lib/compose/analyze'
import { type WatchtowerConfig, watchtowerConfig } from '../../shared/schemas/watchtower'

const wt = (over: Partial<WatchtowerConfig> = {}): WatchtowerConfig => watchtowerConfig.parse({ enabled: true, mode: 'automatic', services: { web: 'update', cache: 'monitor' }, ...over })

const ctx = (over: Partial<AnalyzeContext> = {}): AnalyzeContext => ({
  projectSlug: 'shop',
  projectId: 'p1',
  environmentKey: 'staging',
  environmentId: 'e-stg',
  releaseSlug: 'r-0001-abcdef',
  composeDir: '',
  files: new Set(['Dockerfile', 'compose.yml']),
  variables: {},
  portRules: [],
  portApprovals: [],
  volumeRules: [],
  runtimeDir: '/srv/apps-data/staging/shop',
  workingRoots: ['/srv/deployments/staging'],
  networks: [],
  dockerVolumes: [],
  watchtower: wt(),
  sourceKind: 'zip',
  ...over,
})

const COMPOSE = `
services:
  web:
    image: registry.local/shop/web:1.4
    labels:
      com.centurylinklabs.watchtower.enable: "false"
  cache:
    image: redis:7.4
  worker:
    image: registry.local/shop/worker:1.4
`
const errors = (r: ReturnType<typeof analyzeCompose>) => r.issues.filter(i => i.severity === 'error').map(i => i.code)
const finalOf = (r: ReturnType<typeof analyzeCompose>) => YAML.parse(r.finalYaml!) as { services: Record<string, { labels: Record<string, string>, environment?: Record<string, string>, volumes?: string[], image: string }> }

const PROFILE = { scope: 'wt-abcd1234', name: 'Nuit' }
const profileRow = (over: Record<string, unknown> = {}) => ({
  id: 'abcd1234-0000-4000-8000-000000000000', endpointId: 'e1', name: 'Nuit', timing: 'interval' as const, intervalSec: 86_400, schedule: '0 0 4 * * *',
  cleanup: true, stopTimeoutSec: 30, hookSecretId: null, applied: null, appliedAt: null, createdAt: new Date(), ...over,
})

describe('Watchtower dans le Compose final (profil du serveur)', () => {
  it('aucun Watchtower dans la stack : services rattachés au profil par labels', () => {
    const r = analyzeCompose(COMPOSE, ctx({ watchtowerProfile: PROFILE }))
    expect(errors(r)).toEqual([])
    const f = finalOf(r)
    expect(f.services[WATCHTOWER_SERVICE]).toBeUndefined()
    expect(r.services).not.toContain(WATCHTOWER_SERVICE)
    expect(r.issues.map(i => i.code)).toContain('watchtower.socket')
  })

  it('pose les labels par service selon la politique choisie, au scope du profil (les labels du Compose sont remplacés)', () => {
    const f = finalOf(analyzeCompose(COMPOSE, ctx({ watchtowerProfile: PROFILE })))
    expect(f.services.web!.labels).toMatchObject({ 'com.centurylinklabs.watchtower.enable': 'true' })
    expect(f.services.web!.labels['com.centurylinklabs.watchtower.monitor-only']).toBeUndefined()
    expect(f.services.cache!.labels).toMatchObject({ 'com.centurylinklabs.watchtower.enable': 'true', 'com.centurylinklabs.watchtower.monitor-only': 'true' })
    expect(f.services.worker!.labels['com.centurylinklabs.watchtower.enable']).toBe('false')
    for (const s of ['web', 'cache', 'worker']) expect(f.services[s]!.labels['com.centurylinklabs.watchtower.scope']).toBe('wt-abcd1234')
  })

  it('sans profil : refusé', () => {
    expect(errors(analyzeCompose(COMPOSE, ctx()))).toContain('watchtower.profile')
  })

  it('mode manuel : détection seule (monitor-only par service)', () => {
    const r = analyzeCompose(COMPOSE, ctx({ watchtower: wt({ mode: 'manual' }), watchtowerProfile: PROFILE }))
    expect(r.watchtower.find(w => w.service === 'web')!.policy).toBe('monitor')
    expect(finalOf(r).services.web!.labels['com.centurylinklabs.watchtower.monitor-only']).toBe('true')
  })

  it('mode labels : la politique vient des labels du Compose', () => {
    const labels = { 'com.centurylinklabs.watchtower.enable': 'true', 'com.centurylinklabs.watchtower.monitor-only': 'true' }
    expect(watchtowerPolicyOf(wt({ mode: 'labels' }), 'x', labels)).toBe('monitor')
    expect(watchtowerPolicyOf(wt({ mode: 'labels' }), 'x', {})).toBe('off')
    const r = analyzeCompose(COMPOSE, ctx({ watchtower: wt({ mode: 'labels' }), watchtowerProfile: PROFILE }))
    expect(r.watchtower.find(w => w.service === 'web')!.policy).toBe('off')
  })

  it('refuse une image construite par la plateforme ou figée par empreinte', () => {
    const src = `
services:
  api:
    build: .
  db:
    image: postgres@sha256:${'a'.repeat(64)}
`
    const r = analyzeCompose(src, ctx({ watchtower: wt({ services: { api: 'update', db: 'monitor' } }), watchtowerProfile: PROFILE }))
    expect(errors(r)).toEqual(['watchtower.service', 'watchtower.service'])
    expect(r.finalYaml).toBeNull()
  })

  it('signale une image flottante mise à jour automatiquement', () => {
    const r = analyzeCompose('services:\n  web:\n    image: nginx\n', ctx({ watchtower: wt({ services: { web: 'update' } }), watchtowerProfile: PROFILE }))
    expect(r.issues.find(i => i.code === 'watchtower.floating')?.severity).toBe('warning')
  })

  it('source Git : écart avec le dépôt à confirmer explicitement', () => {
    expect(errors(analyzeCompose(COMPOSE, ctx({ sourceKind: 'github', watchtowerProfile: PROFILE })))).toContain('watchtower.git_drift')
    const ok = analyzeCompose(COMPOSE, ctx({ sourceKind: 'github', watchtower: wt({ acknowledgeGitDrift: true }), watchtowerProfile: PROFILE }))
    expect(errors(ok)).toEqual([])
    expect(ok.issues.find(i => i.code === 'watchtower.git_drift')?.severity).toBe('warning')
    // Détection seule : pas d'écart possible.
    expect(errors(analyzeCompose(COMPOSE, ctx({ sourceKind: 'github', watchtower: wt({ mode: 'manual' }), watchtowerProfile: PROFILE })))).toEqual([])
  })

  it('désactivé : aucun service ajouté, labels Watchtower ignorés', () => {
    const r = analyzeCompose(COMPOSE, ctx({ watchtower: null }))
    expect(finalOf(r).services[WATCHTOWER_SERVICE]).toBeUndefined()
    expect(r.watchtower).toEqual([])
    expect(r.issues.map(i => i.code)).toContain('watchtower.labels_ignored')
  })

  it('refuse un service du Compose portant le nom réservé', () => {
    expect(errors(analyzeCompose(`services:\n  ${WATCHTOWER_SERVICE}:\n    image: x:1\n`, ctx({ watchtower: null })))).toContain('watchtower.reserved')
  })
})

describe('Watchtower d\'un profil (un conteneur par profil et par serveur)', async () => {
  const { profileCompose, profileScope } = await import('../../server/services/watchtower-profiles')
  const svcOf = (yaml: string) => (YAML.parse(yaml) as { services: { watchtower: { image: string, volumes: string[], environment: Record<string, string>, labels: Record<string, string> } } }).services.watchtower

  it('scope du profil, intervalle, notification par l\'environnement ; jamais surveillé lui-même', () => {
    const w = svcOf(profileCompose(profileRow() as never, 'nickfedor/watchtower:1.23.0', []))
    expect(profileScope(profileRow())).toBe('wt-abcd1234')
    expect(w.image).toBe('nickfedor/watchtower:1.23.0')
    expect(w.volumes).toEqual(['/var/run/docker.sock:/var/run/docker.sock'])
    expect(w.environment).toMatchObject({ WATCHTOWER_SCOPE: 'wt-abcd1234', WATCHTOWER_LABEL_ENABLE: 'true', WATCHTOWER_POLL_INTERVAL: '86400', WATCHTOWER_CLEANUP: 'true', WATCHTOWER_TIMEOUT: '30s', WATCHTOWER_NOTIFICATION_URL: '${PLATFORM_WATCHTOWER_HOOK}' })
    expect(w.environment.WATCHTOWER_DISABLE_CONTAINERS).toBeUndefined()
    expect(w.labels).toMatchObject({ 'com.centurylinklabs.watchtower.enable': 'false', 'platform.role': 'watchtower-profile' })
  })

  it('échappe le template de rapport pour Compose ($$ → $ une fois interpolé)', () => {
    const tpl = svcOf(profileCompose(profileRow() as never, 'x:1', [])).environment.WATCHTOWER_NOTIFICATION_TEMPLATE!
    expect(tpl).toContain('{{range $$i, $$c := .Report.Updated}}')
    expect(tpl.replaceAll('$$', '$')).toBe(WATCHTOWER_REPORT_TEMPLATE)
  })

  it('registres privés : config.json fourni par Compose, contenu jamais écrit dans le Compose', async () => {
    const { dockerConfigJson } = await import('../../server/services/watchtower-profiles')
    const yaml = profileCompose(profileRow() as never, 'x:1', [], true)
    const doc = YAML.parse(yaml) as { services: { watchtower: { configs: { source: string, target: string }[], environment: Record<string, string> } }, configs: Record<string, { content: string }> }
    expect(doc.services.watchtower.configs).toEqual([{ source: 'dockercfg', target: '/config.json', mode: 0o400 }])
    expect(doc.services.watchtower.environment.DOCKER_CONFIG).toBe('/')
    expect(doc.configs.dockercfg!.content).toBe('${PLATFORM_WATCHTOWER_DOCKERCFG}')
    const cfg = JSON.parse(dockerConfigJson([{ registry: 'harbor.local:5000', username: 'robot', password: 's3cret' }, { registry: 'docker.io', username: 'me', password: 'tok' }])) as { auths: Record<string, { auth: string }> }
    expect(Buffer.from(cfg.auths['harbor.local:5000']!.auth, 'base64').toString()).toBe('robot:s3cret')
    expect(cfg.auths['https://index.docker.io/v1/']).toBeDefined()
    expect(yaml).not.toContain('s3cret')
    // Sans registre : aucun config.json.
    expect(profileCompose(profileRow() as never, 'x:1', [])).not.toContain('config.json')
  })

  it('planification (cron à 6 champs) et projets en pause exclus', () => {
    const w = svcOf(profileCompose(profileRow({ timing: 'schedule', schedule: '0 30 3 * * 1' }) as never, 'x:1', ['shop-staging-web-1', 'shop-staging-cache-1']))
    expect(w.environment).toMatchObject({ WATCHTOWER_SCHEDULE: '0 30 3 * * 1', WATCHTOWER_DISABLE_CONTAINERS: 'shop-staging-web-1,shop-staging-cache-1' })
    expect(w.environment.WATCHTOWER_POLL_INTERVAL).toBeUndefined()
    expect(() => watchtowerConfig.parse({ schedule: '0 4 * * *' })).toThrow()
  })
})

describe('rapport Watchtower reçu par la plateforme', async () => {
  const { parseReport } = await import('../../server/services/watchtower')

  it('lit le rapport JSON produit par le template', () => {
    const r = parseReport('{"updated":[{"name":"/shop-staging-web-1","image":"r/web:1","from":"aaa","to":"bbb"}],"failed":[],"stale":[{"name":"c","image":"r/c:1","from":"x","to":"y"}]}')
    expect(r?.updated[0]).toMatchObject({ name: '/shop-staging-web-1', to: 'bbb' })
    expect(r?.stale).toHaveLength(1)
  })

  it('ignore un corps vide, non JSON ou hors contrat (le constat sur les conteneurs reste fait)', () => {
    expect(parseReport('')).toBeNull()
    expect(parseReport('Watchtower updated 1 container')).toBeNull()
    expect(parseReport('{"updated":"oui"}')).toBeNull()
    expect(parseReport(`{"failed":[${Array.from({ length: 201 }, () => '{"name":"a","image":"b"}').join(',')}]}`)).toBeNull()
  })
})
