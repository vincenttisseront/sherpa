/** Nettoyage des analyses de la page Vulnérabilités : motifs, aperçu, serveur injoignable. */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { databaseAvailable, setupTestDatabase } from '../helpers/db'

const available = await databaseAvailable()
// Conteneurs en marche sur l'endpoint « local » ; l'endpoint « panne » ne répond pas.
vi.mock('../../server/adapters/portainer', async (orig) => {
  const real = await orig<typeof import('../../server/adapters/portainer')>()
  return {
    ...real,
    portainer: () => ({
      listContainers: async (_conn: unknown, endpointId: number) => {
        if (endpointId === 2) throw new Error('injoignable')
        return [
          { state: 'running', image: 'n8nio/n8n:2.45.7', imageId: 'sha256:n8n-new' },
          { state: 'running', image: 'postgres:16', imageId: 'sha256:pg16' },
          { state: 'exited', image: 'redis:7', imageId: 'sha256:redis7' },
        ]
      },
    }),
  }
})
vi.mock('../../server/services/servers', async (orig) => ({ ...(await orig<object>()), connectionFor: async () => ({}) }))

describe.skipIf(!available)('nettoyage des analyses', () => {
  let dbm: typeof import('../../server/db/client')
  let trivy: typeof import('../../server/services/trivy')
  let local: string
  let sourceIds: { archived: string, active: string }
  const zero = { CRITICAL: 0, HIGH: 0, MEDIUM: 0, LOW: 0, UNKNOWN: 0 }
  const ago = (h: number) => new Date(Date.now() - h * 3600_000)

  beforeAll(async () => {
    await setupTestDatabase('trivy_cleanup')
    dbm = await import('../../server/db/client')
    trivy = await import('../../server/services/trivy')
    const { eq } = await import('drizzle-orm')
    const { encryptSecret } = await import('../../server/utils/crypto')
    const { envelope, keyId } = encryptSecret('t')
    const [sec] = await dbm.db().insert(dbm.schema.secrets).values({ purpose: 'agent_secret', envelope, keyId }).returning()
    const [server] = await dbm.db().insert(dbm.schema.portainerServers).values({ name: 's', url: 'https://p.test', tokenSecretId: sec!.id } as never).returning()
    const [a] = await dbm.db().insert(dbm.schema.serverEndpoints).values({ serverId: server!.id, portainerEndpointId: 1, name: 'local', type: 'docker_standalone', enabled: true } as never).returning()
    const [b] = await dbm.db().insert(dbm.schema.serverEndpoints).values({ serverId: server!.id, portainerEndpointId: 2, name: 'panne', type: 'docker_standalone', enabled: true } as never).returning()
    local = a!.id
    const scan = (endpointId: string, image: string, imageId: string, o: { h?: number, error?: boolean } = {}) => ({ endpointId, image, imageId, scannedAt: ago(o.h ?? 1), status: o.error ? 'error' as const : 'ok' as const, error: o.error ? 'délai dépassé' : null, counts: zero })
    await dbm.db().insert(dbm.schema.imageScans).values([
      scan(local, 'n8nio/n8n:2.45.7', 'sha256:n8n-new', { h: 1 }),
      // Même image, ancienne empreinte : en double, et ne tourne plus (empreinte) mais même référence.
      scan(local, 'n8nio/n8n:2.45.7', 'sha256:n8n-old', { h: 48 }),
      // Version arrêtée.
      scan(local, 'n8nio/n8n:2.40.0', 'sha256:n8n-240', { h: 72 }),
      scan(local, 'postgres:16', 'sha256:pg16', { error: true }),
      scan(local, 'redis:7', 'sha256:redis7'),
      // Serveur injoignable : jamais compté comme arrêté.
      scan(b!.id, 'nginx:1.27', 'sha256:nginx'),
    ])
    const [env] = await dbm.db().select().from(dbm.schema.environments).where(eq(dbm.schema.environments.key, 'staging'))
    const target = async (slug: string, archived: boolean) => {
      const [p] = await dbm.db().insert(dbm.schema.projects).values({ slug, name: slug, archivedAt: archived ? new Date() : null }).returning()
      const [t] = await dbm.db().insert(dbm.schema.projectTargets).values({ projectId: p!.id, endpointId: local, environmentId: env!.id, stackName: `${slug}-staging` } as never).returning()
      if (!archived) {
        const [rel] = await dbm.db().insert(dbm.schema.releases).values({ targetId: t!.id, number: 1, sourceKind: 'zip' } as never).returning()
        await dbm.db().update(dbm.schema.projectTargets).set({ currentReleaseId: rel!.id }).where(eq(dbm.schema.projectTargets.id, t!.id))
      }
      const [s] = await dbm.db().insert(dbm.schema.sourceScans).values({ targetId: t!.id, status: 'ok', counts: zero }).returning()
      return s!.id
    }
    sourceIds = { archived: await target('archive', true), active: await target('actif', false) }
  }, 30_000)
  afterAll(async () => {
    await dbm?.closeDb()
  })

  const images = async () => (await dbm.db().select().from(dbm.schema.imageScans)).map(r => `${r.image}@${r.imageId}`).sort()

  it('aperçu par motif, sans suppression', async () => {
    const r = await trivy.cleanupScans({ stale: true, duplicates: true, failed: true, sources: true, all: false, dryRun: true })
    // Arrêtées : 2.40.0 et redis (conteneur arrêté) ; l'ancienne empreinte de 2.45.7 garde sa référence en marche.
    expect(r.byReason).toEqual({ stale: 2, duplicates: 1, failed: 1, sources: 1 })
    expect(r.images).toBe(4)
    expect(r.unreachable).toEqual(['s / panne'])
    expect(await images()).toHaveLength(6)
  })

  it('suppression : seules les analyses retenues disparaissent', async () => {
    const r = await trivy.cleanupScans({ stale: true, duplicates: true, failed: false, sources: false, all: false, dryRun: false })
    expect(r.images).toBe(3)
    expect(await images()).toEqual(['n8nio/n8n:2.45.7@sha256:n8n-new', 'nginx:1.27@sha256:nginx', 'postgres:16@sha256:pg16'])
  })

  it('code source : cibles sans release active, puis tout', async () => {
    const sources = async () => (await dbm.db().select({ id: dbm.schema.sourceScans.id }).from(dbm.schema.sourceScans)).map(r => r.id)
    const r = await trivy.cleanupScans({ stale: false, duplicates: false, failed: false, sources: true, all: false, dryRun: false })
    // Projet archivé retiré, cible avec release active conservée.
    expect(r.sources).toBe(1)
    expect(await sources()).toEqual([sourceIds.active])
    const all = await trivy.cleanupScans({ stale: false, duplicates: false, failed: false, sources: false, all: true, dryRun: false })
    expect([all.images, all.sources]).toEqual([3, 1])
    expect(await images()).toEqual([])
    expect(await sources()).toEqual([])
  })
})
