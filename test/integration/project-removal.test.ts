/** Fin de vie d'un projet : détachement (rien sur l'hôte) et suppression définitive. */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { databaseAvailable, setupTestDatabase } from '../helpers/db'

const available = await databaseAvailable()
const calls: string[] = []
vi.mock('../../server/adapters/portainer', async (orig) => {
  const real = await orig<typeof import('../../server/adapters/portainer')>()
  const fake = {
    stackContainers: async () => [{ id: 'w1', name: 'shop-staging-platform-watchtower-1', service: 'platform-watchtower', running: true }, { id: 'a1', name: 'shop-staging-web-1', service: 'web', running: true }],
    stopContainer: async (_c: unknown, _e: unknown, id: string) => void calls.push(`stop:${id}`),
    removeContainer: async (_c: unknown, _e: unknown, id: string) => void calls.push(`rm:${id}`),
    deleteStack: async () => void calls.push('deleteStack'),
  }
  return { ...real, portainer: () => fake }
})
vi.mock('../../server/queue/queues', async (orig) => ({ ...(await orig<object>()), enqueueDeployment: vi.fn(async () => {}) }))

describe.skipIf(!available)('fin de vie d\'un projet', () => {
  let dbm: typeof import('../../server/db/client')
  let mod: typeof import('../../server/services/project-removal')
  let eq: typeof import('drizzle-orm')['eq']
  let endpointId: string
  let envId: string

  async function project(slug: string, deployed: boolean, watchtower = false) {
    const { encryptSecret } = await import('../../server/utils/crypto')
    const { envelope, keyId } = encryptSecret('{}')
    const [sec] = await dbm.db().insert(dbm.schema.secrets).values({ purpose: 'target_variables', envelope, keyId }).returning()
    const [p] = await dbm.db().insert(dbm.schema.projects).values({ slug, name: slug }).returning()
    const [t] = await dbm.db().insert(dbm.schema.projectTargets).values({ projectId: p!.id, endpointId, environmentId: envId, stackName: deployed ? `${slug}-staging` : null, portainerStackId: deployed ? 3 : null, envSecretId: sec!.id, watchtowerApplied: watchtower ? { enabled: true } : null } as never).returning()
    return { projectId: p!.id, targetId: t!.id, secretId: sec!.id }
  }

  beforeAll(async () => {
    await setupTestDatabase('project_removal')
    dbm = await import('../../server/db/client')
    mod = await import('../../server/services/project-removal')
    eq = (await import('drizzle-orm')).eq
    const { encryptSecret } = await import('../../server/utils/crypto')
    const { envelope, keyId } = encryptSecret('t')
    const [sec] = await dbm.db().insert(dbm.schema.secrets).values({ purpose: 'agent_secret', envelope, keyId }).returning()
    const [server] = await dbm.db().insert(dbm.schema.portainerServers).values({ name: 's', url: 'https://p.test', tokenSecretId: sec!.id } as never).returning()
    const [ep] = await dbm.db().insert(dbm.schema.serverEndpoints).values({ serverId: server!.id, portainerEndpointId: 1, name: 'local', type: 'docker_standalone', enabled: true } as never).returning()
    const [env] = await dbm.db().select().from(dbm.schema.environments).where(eq(dbm.schema.environments.key, 'staging'))
    endpointId = ep!.id
    envId = env!.id
  }, 30_000)
  afterAll(async () => {
    await dbm?.closeDb()
  })

  it('détachement : rien n\'est touché sur l\'hôte, projet et variables chiffrées retirés', async () => {
    const p = await project('shop', true)
    calls.length = 0
    const r = await mod.detachProject(p.projectId, { stopWatchtower: false })
    expect(r.targets[0]).toMatchObject({ stack: 'shop-staging' })
    expect(calls).toEqual([])
    expect(await dbm.db().$count(dbm.schema.projects, eq(dbm.schema.projects.id, p.projectId))).toBe(0)
    expect(await dbm.db().$count(dbm.schema.secrets, eq(dbm.schema.secrets.id, p.secretId))).toBe(0)
  })

  it('détachement avec retrait du Watchtower de la plateforme : seul ce conteneur est retiré', async () => {
    const p = await project('blog', true, true)
    calls.length = 0
    const r = await mod.detachProject(p.projectId, { stopWatchtower: true })
    expect(calls).toEqual(['stop:w1', 'rm:w1'])
    expect(r.watchtowerStopped).toEqual(['shop-staging-platform-watchtower-1'])
  })

  it('suppression définitive sans stack : retiré tout de suite', async () => {
    const p = await project('draft', false)
    expect(await mod.deleteProjectDefinitively(p.projectId, null, 'k1')).toEqual({ deploymentIds: [], removed: true })
    expect(await dbm.db().$count(dbm.schema.projects, eq(dbm.schema.projects.id, p.projectId))).toBe(0)
  })

  it('suppression définitive avec stack : suppression mise en file, projet retiré à la fin', async () => {
    const p = await project('api', true)
    const r = await mod.deleteProjectDefinitively(p.projectId, null, 'k2')
    expect(r.removed).toBe(false)
    const [d] = await dbm.db().select().from(dbm.schema.deployments).where(eq(dbm.schema.deployments.id, r.deploymentIds[0]!))
    expect(d).toMatchObject({ action: 'delete', options: { deleteProject: true } })
    // Opération en cours : ni détachement ni retrait.
    await expect(mod.detachProject(p.projectId, { stopWatchtower: false })).rejects.toMatchObject({ statusCode: 409 })
    expect(await mod.finishProjectDeletion(p.projectId)).toBe(false)
    // Fin de la suppression de la stack (fait par le pipeline) : le projet est retiré.
    await dbm.db().update(dbm.schema.deployments).set({ status: 'DELETED' }).where(eq(dbm.schema.deployments.id, d!.id))
    await dbm.db().update(dbm.schema.projectTargets).set({ portainerStackId: null }).where(eq(dbm.schema.projectTargets.id, p.targetId))
    expect(await mod.finishProjectDeletion(p.projectId)).toBe(true)
    expect(await dbm.db().$count(dbm.schema.projects, eq(dbm.schema.projects.id, p.projectId))).toBe(0)
  })
})
