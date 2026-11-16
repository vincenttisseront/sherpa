/** Nettoyage Docker : protections, filtres transmis à Docker, revalidation à l'exécution, refus pendant une opération. */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { databaseAvailable, setupTestDatabase } from '../helpers/db'

const available = await databaseAvailable()
const calls: { op: string, arg: unknown }[] = []

vi.mock('../../server/adapters/portainer', async (orig) => {
  const real = await orig<typeof import('../../server/adapters/portainer')>()
  const fake = {
    diskUsage: async () => ({
      usage: { images: { count: 3, active: 0, sizeBytes: 300, reclaimableBytes: 300 }, containers: { count: 2, running: 0, sizeBytes: 0, reclaimableBytes: 0 }, volumes: { count: 3, active: 1, sizeBytes: 30, reclaimableBytes: 20 }, buildCache: { count: 5, sizeBytes: 50, reclaimableBytes: 40 } },
      volumes: [
        { name: 'shop-staging_data', driver: 'local', labels: { 'com.docker.compose.project': 'shop-staging' }, sizeBytes: 10, refCount: 0, createdAt: null },
        { name: 'old-thing', driver: 'local', labels: {}, sizeBytes: 10, refCount: 0, createdAt: null },
        { name: 'in-use', driver: 'local', labels: {}, sizeBytes: 10, refCount: 1, createdAt: null },
      ],
      images: [
        { id: 'sha256:live', tags: ['platform/shop-web:r-0002'], sizeBytes: 100, createdAt: '', labels: { 'platform.project': 'shop' }, containers: 0, dangling: false },
        { id: 'sha256:orphan', tags: [], sizeBytes: 100, createdAt: '', labels: { 'platform.project': 'deleted-proj' }, containers: 0, dangling: true },
        { id: 'sha256:other', tags: ['nginx:1'], sizeBytes: 100, createdAt: '', labels: {}, containers: 0, dangling: false },
      ],
    }),
    listContainers: async () => [
      { id: 'c1', names: ['shop-staging-web-1'], image: 'x', state: 'exited', status: 'Exited (0)', labels: { 'platform.managed': 'true', 'com.docker.compose.project': 'shop-staging' }, networks: ['shop-staging_default'], createdAt: '' },
      { id: 'c2', names: ['tmp'], image: 'y', state: 'exited', status: 'Exited (1)', labels: {}, networks: ['bridge'], createdAt: '' },
    ],
    listNetworksDetailed: async () => [
      { id: 'n-traefik', name: 'traefik-public', driver: 'bridge', scope: 'local', internal: false, labels: {}, createdAt: null },
      { id: 'n-old', name: 'old-net', driver: 'bridge', scope: 'local', internal: false, labels: {}, createdAt: null },
      { id: 'n-bridge', name: 'bridge', driver: 'bridge', scope: 'local', internal: false, labels: {}, createdAt: null },
    ],
    pruneContainers: async (_c: unknown, _e: unknown, filters: unknown) => { calls.push({ op: 'pruneContainers', arg: filters }); return { deleted: ['c2'], reclaimedBytes: 5 } },
    pruneImages: async (_c: unknown, _e: unknown, filters: unknown) => { calls.push({ op: 'pruneImages', arg: filters }); return { deleted: ['nginx:1'], reclaimedBytes: 100 } },
    pruneBuildCache: async (_c: unknown, _e: unknown, opts: unknown) => { calls.push({ op: 'pruneBuildCache', arg: opts }); return { deleted: ['a'], reclaimedBytes: 40 } },
    removeVolume: async (_c: unknown, _e: unknown, name: unknown) => { calls.push({ op: 'removeVolume', arg: name }) },
    removeNetwork: async (_c: unknown, _e: unknown, id: unknown) => { calls.push({ op: 'removeNetwork', arg: id }) },
    removeImage: async (_c: unknown, _e: unknown, id: unknown) => { calls.push({ op: 'removeImage', arg: id }) },
  }
  return { ...real, portainer: () => fake }
})

describe.skipIf(!available)('nettoyage Docker', () => {
  let dbm: typeof import('../../server/db/client')
  let mod: typeof import('../../server/services/cleanup')
  let row: Awaited<ReturnType<typeof import('../../server/services/live').liveEndpoints>>[number]
  let targetId: string
  const admin = { id: null, email: 'admin@test', displayName: 'Admin', kind: 'dev', grants: [] } as never

  beforeAll(async () => {
    await setupTestDatabase('cleanup')
    dbm = await import('../../server/db/client')
    mod = await import('../../server/services/cleanup')
    const { encryptSecret } = await import('../../server/utils/crypto')
    const { envelope, keyId } = encryptSecret('t')
    const [sec] = await dbm.db().insert(dbm.schema.secrets).values({ purpose: 'portainer_token', envelope, keyId }).returning()
    const [server] = await dbm.db().insert(dbm.schema.portainerServers).values({ name: 's', url: 'https://p.test', tokenSecretId: sec!.id } as never).returning()
    const [ep] = await dbm.db().insert(dbm.schema.serverEndpoints).values({ serverId: server!.id, portainerEndpointId: 1, name: 'local', type: 'docker_standalone', enabled: true } as never).returning()
    const [env] = await dbm.db().select().from(dbm.schema.environments).limit(1)
    const [project] = await dbm.db().insert(dbm.schema.projects).values({ slug: 'shop', name: 'Shop' }).returning()
    const [t] = await dbm.db().insert(dbm.schema.projectTargets).values({ projectId: project!.id, endpointId: ep!.id, environmentId: env!.id, stackName: 'shop-staging' }).returning()
    targetId = t!.id
    await dbm.db().insert(dbm.schema.networks).values({ endpointId: ep!.id, dockerId: 'n-traefik', name: 'traefik-public', policy: 'allowed' } as never)
    row = { ep: ep!, server: server! }
  }, 30_000)
  afterAll(async () => {
    await (await import('../../server/queue/redis')).closeRedis().catch(() => {})
    await dbm?.closeDb()
  })

  it('aperçu : ce que la plateforme gère est protégé, le reste est candidat', async () => {
    const p = await mod.previewCleanup(row)
    const prot = (xs: { name: string, protectedBy: string | null }[]) => Object.fromEntries(xs.map(x => [x.name, !!x.protectedBy]))
    expect(prot(p.containers)).toEqual({ 'shop-staging-web-1': true, 'tmp': false })
    expect(prot(p.volumes)).toEqual({ 'shop-staging_data': true, 'old-thing': false })
    expect(prot(p.networks)).toEqual({ 'traefik-public': true, 'old-net': false })
    expect(prot([...p.images.dangling, ...p.images.unused])).toEqual({ 'platform/shop-web:r-0002': true, '<sans tag> orphan': false, 'nginx:1': false })
  })

  it('exécution : filtres Docker sûrs, image orpheline retirée, ressources protégées jamais supprimées', async () => {
    calls.length = 0
    const r = await mod.runCleanup(row, { containers: { olderThan24h: true }, images: { mode: 'unused' }, volumes: { names: ['old-thing', 'shop-staging_data', 'in-use'] }, networks: { ids: ['n-old', 'n-traefik'] }, buildCache: { olderThan24h: true } }, admin)
    expect(calls.find(c => c.op === 'pruneContainers')!.arg).toEqual({ 'label!': ['platform.managed=true'], 'until': ['24h'] })
    expect(calls.find(c => c.op === 'pruneImages')!.arg).toEqual({ 'dangling': ['false'], 'label!': ['platform.project'] })
    expect(calls.filter(c => c.op === 'removeImage').map(c => c.arg)).toEqual(['sha256:orphan'])
    expect(calls.filter(c => c.op === 'removeVolume').map(c => c.arg)).toEqual(['old-thing'])
    expect(calls.filter(c => c.op === 'removeNetwork').map(c => c.arg)).toEqual(['n-old'])
    expect(calls.find(c => c.op === 'pruneBuildCache')!.arg).toEqual({ all: true, until: '24h' })
    const vol = r.steps.find(s => s.action === 'volumes')!
    expect(vol.errors.join(' ')).toMatch(/shop-staging_data.*conservé.*in-use.*conservé/)
    expect(r.reclaimedBytes).toBeGreaterThan(0)
    const [a] = await dbm.db().select().from(dbm.schema.auditEvents).where((await import('drizzle-orm')).eq(dbm.schema.auditEvents.action, 'docker.cleanup'))
    expect(a).toBeTruthy()
  })

  it('refusé pendant une opération sur l\'endpoint', async () => {
    await dbm.db().insert(dbm.schema.deployments).values({ targetId, action: 'deploy', status: 'BUILDING', idempotencyKey: 'k-busy' })
    await expect(mod.runCleanup(row, { buildCache: { olderThan24h: true } }, admin)).rejects.toMatchObject({ statusCode: 409 })
  })
})
