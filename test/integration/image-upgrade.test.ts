/**
 * Mise à niveau des images : plan (origine, versions de même forme, services liés),
 * application (surcharges, contrôles, options du redéploiement) et effet à l'analyse.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { databaseAvailable, setupTestDatabase } from '../helpers/db'

const available = await databaseAvailable()

const TAGS: Record<string, string[]> = {
  'netboxcommunity/netbox': ['v4.7-5.1.1', 'v4.7-5.1.2', 'v4.8-5.2.0', 'v5.0-6.0.0', 'v4.8-5.2.0-ldap', 'latest'],
  'library/postgres': ['17-alpine', '18-alpine', '19-alpine', '18', '19'],
  'acme/api': ['1.4.0', '1.4.1', '1.5.0'],
  'library/mariadb': ['latest', '11.4', '11.8'],
  'library/vitrine-admin': [],
}
vi.mock('../../server/lib/registry', async (orig) => {
  const real = await orig<typeof import('../../server/lib/registry')>()
  return {
    ...real,
    listTags: vi.fn(async (ref: { repository: string }) => TAGS[ref.repository] ?? []),
    remoteDigest: vi.fn(async (ref: { tag: string }) => `sha256:${'d'.repeat(56)}${ref.tag.replace(/[^0-9]/g, '').padEnd(8, '0').slice(0, 8)}`),
  }
})
vi.mock('../../server/services/image-freshness', () => ({
  targetFreshness: vi.fn(async (targetId: string) => ({ targetId, checkedAt: new Date().toISOString(), error: null, services: [{ service: 'db', image: 'postgres:18-alpine', state: 'outdated', detail: '' }] })),
  freshnessOf: vi.fn(async () => []),
}))
vi.mock('../../server/queue/queues', async (orig) => ({ ...(await orig<object>()), enqueueDeployment: vi.fn(async () => {}) }))

const COMPOSE = `services:
  netbox: &netbox
    image: docker.io/netboxcommunity/netbox:\${VERSION-v4.7-5.1.1}
  netbox-worker:
    <<: *netbox
    command: [rqworker]
  db:
    image: docker.io/postgres:18-alpine
  api:
    image: acme/api:1.4.0@sha256:${'a'.repeat(64)}
  maria:
    image: mariadb:latest
  admin:
    image: vitrine-admin:local
  web:
    build: ./web
`
const IMAGES = {
  'netbox': 'docker.io/netboxcommunity/netbox:v4.7-5.1.1',
  'netbox-worker': 'docker.io/netboxcommunity/netbox:v4.7-5.1.1',
  'db': 'docker.io/postgres:18-alpine',
  'api': `acme/api:1.4.0@sha256:${'a'.repeat(64)}`,
  'maria': 'mariadb:latest',
  'admin': 'vitrine-admin:local',
  'web': 'platform/up-web:r-0001-aaaaaa',
}

describe.skipIf(!available)('mise à niveau des images', () => {
  let dbm: typeof import('../../server/db/client')
  let mod: typeof import('../../server/services/image-upgrade')
  let getTarget: typeof import('../../server/services/projects')['getTargetOr404']
  let targetId: string
  const user = { id: null, email: 'ops@acme.test' }

  beforeAll(async () => {
    await setupTestDatabase('image_upgrade')
    dbm = await import('../../server/db/client')
    mod = await import('../../server/services/image-upgrade')
    getTarget = (await import('../../server/services/projects')).getTargetOr404
    const { eq } = await import('drizzle-orm')
    const { encryptSecret } = await import('../../server/utils/crypto')
    const { envelope, keyId } = encryptSecret('t')
    const [sec] = await dbm.db().insert(dbm.schema.secrets).values({ purpose: 'agent_secret', envelope, keyId }).returning()
    const [server] = await dbm.db().insert(dbm.schema.portainerServers).values({ name: 's', url: 'https://p.test', tokenSecretId: sec!.id } as never).returning()
    const [ep] = await dbm.db().insert(dbm.schema.serverEndpoints).values({ serverId: server!.id, portainerEndpointId: 1, name: 'local', type: 'docker_standalone', enabled: true } as never).returning()
    const [env] = await dbm.db().select().from(dbm.schema.environments).where(eq(dbm.schema.environments.key, 'staging'))
    const [p] = await dbm.db().insert(dbm.schema.projects).values({ slug: 'up', name: 'Up' }).returning()
    const [t] = await dbm.db().insert(dbm.schema.projectTargets).values({ projectId: p!.id, endpointId: ep!.id, environmentId: env!.id, stackName: 'up-staging', portainerStackId: 7 } as never).returning()
    const [rel] = await dbm.db().insert(dbm.schema.releases).values({ targetId: t!.id, number: 1, sourceKind: 'zip', slug: 'r-0001-aaaaaa', composePath: 'compose.yml', composeSource: COMPOSE, composeFinal: 'services: {}\n', images: IMAGES } as never).returning()
    await dbm.db().update(dbm.schema.projectTargets).set({ currentReleaseId: rel!.id }).where(eq(dbm.schema.projectTargets.id, t!.id))
    targetId = t!.id
  }, 30_000)
  afterAll(async () => {
    await dbm?.closeDb()
  })

  it('plan : origine de chaque image, versions de même forme, services liés', async () => {
    const plan = await mod.upgradePlan(await getTarget(targetId))
    const by = Object.fromEntries(plan.services.map(s => [s.service, s]))
    expect(by.netbox).toMatchObject({ origin: 'variable', variable: 'VERSION', kind: 'version', compatible: { tag: 'v4.8-5.2.0', level: 'minor' }, major: { tag: 'v5.0-6.0.0' }, linked: ['netbox-worker'] })
    expect(by['netbox-worker']).toMatchObject({ origin: 'variable', linked: ['netbox'] })
    // Majeure de PostgreSQL : signalée, jamais proposée (données à migrer).
    expect(by.db).toMatchObject({ origin: 'literal', stateful: true, sameTagUpdate: true, compatible: null, major: null, migration: { tag: '19-alpine' }, note: expect.stringContaining('Version majeure 19-alpine publiée') })
    expect(by.api).toMatchObject({ kind: 'digest', compatible: { tag: '1.5.0', level: 'minor' } })
    expect(by.maria).toMatchObject({ kind: 'floating', compatible: null, major: null })
    expect(by.admin).toMatchObject({ kind: 'local', compatible: null })
    expect(by.web).toMatchObject({ kind: 'build', origin: 'build' })
    expect(plan.hasBuilds).toBe(true)
  })

  it('refus : version non proposée, majeure d\'un service à données sans confirmation', async () => {
    await expect(mod.applyUpgrade(await getTarget(targetId), { services: [{ service: 'netbox', tag: 'v4.8-5.2.0-ldap' }], refresh: true, cleanBuild: false, confirmMajorData: false }, user, 'k-refus-1'))
      .rejects.toMatchObject({ statusCode: 422 })
    await expect(mod.applyUpgrade(await getTarget(targetId), { services: [{ service: 'db', tag: '19-alpine' }], refresh: true, cleanBuild: false, confirmMajorData: true }, user, 'k-refus-2'))
      .rejects.toMatchObject({ statusCode: 422, statusMessage: expect.stringContaining('doivent être migrées') })
    expect((await getTarget(targetId)).target.composeOverrides?.images ?? {}).toEqual({})
  })

  it('application : services liés ensemble, empreinte de la nouvelle version, options du redéploiement', async () => {
    const r = await mod.applyUpgrade(await getTarget(targetId), { services: [{ service: 'netbox', tag: 'v4.8-5.2.0' }, { service: 'api', tag: '1.5.0' }], refresh: true, cleanBuild: true, confirmMajorData: false }, user, 'k-apply-1')
    expect(r.services.map(s => s.service).sort()).toEqual(['api', 'netbox', 'netbox-worker'])
    const t = await getTarget(targetId)
    const ov = t.target.composeOverrides!.images!
    expect(ov.netbox).toMatchObject({ image: 'docker.io/netboxcommunity/netbox:v4.8-5.2.0', from: 'docker.io/netboxcommunity/netbox:v4.7-5.1.1', by: 'ops@acme.test' })
    expect(ov['netbox-worker']!.image).toBe('docker.io/netboxcommunity/netbox:v4.8-5.2.0')
    expect(ov.api!.image).toMatch(/^acme\/api:1\.5\.0@sha256:d+/)
    const { eq } = await import('drizzle-orm')
    const [d] = await dbm.db().select().from(dbm.schema.deployments).where(eq(dbm.schema.deployments.id, r.deploymentId))
    expect(d).toMatchObject({ action: 'redeploy', status: 'QUEUED' })
    expect(d!.options).toMatchObject({ cleanBuild: true, upgrade: { previousImages: {}, previousComposeFinal: 'services: {}\n', previousReleaseImages: IMAGES } })
    // L'opération en file bloque une deuxième demande.
    await expect(mod.applyUpgrade(t, { services: [], refresh: true, cleanBuild: false, confirmMajorData: false }, user, 'k-apply-2')).rejects.toMatchObject({ statusCode: 409 })
    await dbm.db().update(dbm.schema.deployments).set({ status: 'HEALTHY' }).where(eq(dbm.schema.deployments.id, r.deploymentId))
  })

  it('analyse : surcharges appliquées ; Compose source mis à niveau pour la source', async () => {
    const { analyzeForTarget } = await import('../../server/services/projects')
    const t = await getTarget(targetId)
    const res = await analyzeForTarget(t, { composeText: COMPOSE.replace(/ {2}web:\n {4}build: \.\/web\n/, ''), composePath: 'compose.yml', files: new Set(['compose.yml']), releaseSlug: 'r-0002-bbbbbb', portApprovals: [], variables: {} })
    expect(res.images.netbox).toBe('docker.io/netboxcommunity/netbox:v4.8-5.2.0')
    expect(res.images['netbox-worker']).toBe('docker.io/netboxcommunity/netbox:v4.8-5.2.0')
    expect(res.issues.filter(i => i.code === 'image.upgrade').map(i => i.service).sort()).toEqual(['api', 'netbox', 'netbox-worker'])
    const c = await mod.upgradedCompose(t)
    expect(c.composeText).toContain('netbox:${VERSION-v4.8-5.2.0}')
    expect(c.composeText).toMatch(/image: acme\/api:1\.5\.0@sha256:d+/)
    expect(c.manual).toEqual([])
  })

  it('retour à la version du Compose : surcharge retirée', async () => {
    // La surcharge part de la version d'origine : revenir à v4.7-5.1.1 n'est pas « plus récent », donc refusé.
    await expect(mod.applyUpgrade(await getTarget(targetId), { services: [{ service: 'netbox', tag: 'v4.7-5.1.1' }], refresh: true, cleanBuild: false, confirmMajorData: false }, user, 'k-back-1'))
      .rejects.toMatchObject({ statusCode: 422 })
  })

  it('retour à la version du Compose : surcharge retirée pour le service et ses services liés', async () => {
    const r = await mod.applyUpgrade(await getTarget(targetId), { services: [], reset: ['netbox'], refresh: true, cleanBuild: false, confirmMajorData: false }, user, 'k-reset-1')
    expect(r.services.map(s => s.service).sort()).toEqual(['netbox', 'netbox-worker'])
    expect(r.services[0]!.to).toBe('netboxcommunity/netbox:v4.7-5.1.1')
    const ov = (await getTarget(targetId)).target.composeOverrides!.images!
    expect(Object.keys(ov)).toEqual(['api'])
    await expect(mod.applyUpgrade(await getTarget(targetId), { services: [], reset: ['db'], refresh: true, cleanBuild: false, confirmMajorData: false }, user, 'k-reset-2')).rejects.toMatchObject({ statusCode: 422 })
  })
})
