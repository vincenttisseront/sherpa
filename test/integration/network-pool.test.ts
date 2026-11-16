/** Sous-réseaux des réseaux de projets : libération des attributions des stacks supprimées. */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { databaseAvailable, setupTestDatabase } from '../helpers/db'

const available = await databaseAvailable()
vi.mock('../../server/adapters/portainer', async (orig) => {
  const real = await orig<typeof import('../../server/adapters/portainer')>()
  return { ...real, portainer: () => ({ listNetworksDetailed: async () => [] }) }
})
vi.mock('../../server/services/servers', async (orig) => ({ ...(await orig<object>()), connectionFor: async () => ({}) }))

describe.skipIf(!available)('libération des sous-réseaux', () => {
  let dbm: typeof import('../../server/db/client')
  let pool: typeof import('../../server/services/network-pool')
  let projects: typeof import('../../server/services/projects')
  let eq: typeof import('drizzle-orm')['eq']
  let endpointId: string
  let envId: string

  /** Cible d'un projet, avec ses attributions (réseau → [sous-réseau, fixé à la main]). */
  async function target(slug: string, o: { archived?: boolean, stack?: boolean, subnets?: Record<string, [string, boolean]> }) {
    const [p] = await dbm.db().insert(dbm.schema.projects).values({ slug, name: slug, archivedAt: o.archived ? new Date() : null }).returning()
    const [t] = await dbm.db().insert(dbm.schema.projectTargets).values({ projectId: p!.id, endpointId, environmentId: envId, stackName: `${slug}-staging`, portainerStackId: o.stack ? 7 : null } as never).returning()
    for (const [network, [subnet, pinned]] of Object.entries(o.subnets ?? {})) {
      await dbm.db().insert(dbm.schema.networkAllocations).values({ endpointId, targetId: t!.id, network, subnet, pinned })
    }
    return t!.id
  }
  const subnetsOf = async (targetId: string) => (await dbm.db().select().from(dbm.schema.networkAllocations).where(eq(dbm.schema.networkAllocations.targetId, targetId))).map(a => a.subnet).sort()

  beforeAll(async () => {
    await setupTestDatabase('network_pool')
    dbm = await import('../../server/db/client')
    pool = await import('../../server/services/network-pool')
    projects = await import('../../server/services/projects')
    eq = (await import('drizzle-orm')).eq
    const { encryptSecret } = await import('../../server/utils/crypto')
    const { envelope, keyId } = encryptSecret('t')
    const [sec] = await dbm.db().insert(dbm.schema.secrets).values({ purpose: 'agent_secret', envelope, keyId }).returning()
    const [server] = await dbm.db().insert(dbm.schema.portainerServers).values({ name: 's', url: 'https://p.test', tokenSecretId: sec!.id } as never).returning()
    // 8 créneaux de /27.
    const [ep] = await dbm.db().insert(dbm.schema.serverEndpoints).values({ serverId: server!.id, portainerEndpointId: 1, name: 'local', type: 'docker_standalone', enabled: true, networkPool: { base: '10.234.0.0/24', prefix: 27, avoid: [] } } as never).returning()
    const [env] = await dbm.db().select().from(dbm.schema.environments).where(eq(dbm.schema.environments.key, 'staging'))
    endpointId = ep!.id
    envId = env!.id
  }, 30_000)
  afterAll(async () => {
    await dbm?.closeDb()
  })

  it('stack supprimée : attributions automatiques libérées, sous-réseau fixé à la main conservé', async () => {
    const id = await target('solo', { subnets: { default: ['10.234.0.224/27', false], front: ['10.234.0.192/27', true] } })
    expect(await pool.releaseTargetSubnets(id)).toBe(1)
    expect(await subnetsOf(id)).toEqual(['10.234.0.192/27'])
    await dbm.db().delete(dbm.schema.projects).where(eq(dbm.schema.projects.slug, 'solo'))
  })

  it('plage occupée par des projets archivés sans stack : libérée à l\'attribution, sauf sous-réseaux fixés et cibles actives', async () => {
    const archived: string[] = []
    for (const [i, slug] of ['e2e-rebuild', 'e2e-gh-public', 'e2e-gh-prive', 'e2e-correction', 'e2e-relance'].entries()) {
      archived.push(await target(slug, { archived: true, subnets: { default: [`10.234.0.${i * 32}/27`, false] } }))
    }
    const pinnedArchived = await target('archive-fixe', { archived: true, subnets: { default: ['10.234.0.160/27', true] } })
    // Projet actif analysé mais pas encore déployé : son attribution reste.
    const pending = await target('en-attente', { subnets: { default: ['10.234.0.192/27', false] } })
    // Projet archivé dont la stack tourne encore : son attribution reste.
    const running = await target('archive-en-service', { archived: true, stack: true, subnets: { default: ['10.234.0.224/27', false] } })

    const t = await projects.getTargetOr404(await target('nouveau', {}))
    // Aperçu : les créneaux libérables sont proposés, rien n'est supprimé.
    const preview = await pool.allocateSubnets(t, ['default', 'back'], { persist: false })
    expect(Object.values(preview.subnets).sort()).toEqual(['10.234.0.0/27', '10.234.0.32/27'])
    expect(await subnetsOf(archived[0]!)).toEqual(['10.234.0.0/27'])

    const r = await pool.allocateSubnets(t, ['default', 'back'])
    expect(r.subnets).toEqual({ default: '10.234.0.0/27', back: '10.234.0.32/27' })
    for (const id of archived) expect(await subnetsOf(id)).toEqual([])
    expect(await subnetsOf(pinnedArchived)).toEqual(['10.234.0.160/27'])
    expect(await subnetsOf(pending)).toEqual(['10.234.0.192/27'])
    expect(await subnetsOf(running)).toEqual(['10.234.0.224/27'])
    expect(await subnetsOf(t.target.id)).toEqual(['10.234.0.0/27', '10.234.0.32/27'])
  })
})
