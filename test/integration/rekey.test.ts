/** Rotation de la clé maîtresse sur une vraie base : aperçu, rechiffrement, idempotence, clé manquante. */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { databaseAvailable, setupTestDatabase } from '../helpers/db'

const available = await databaseAvailable()
const K1 = Buffer.alloc(32, 1).toString('base64')
const K2 = Buffer.alloc(32, 2).toString('base64')

describe.skipIf(!available)('rotation de la clé maîtresse', () => {
  let dbm: typeof import('../../server/db/client')
  let crypto: typeof import('../../server/utils/crypto')
  let envm: typeof import('../../server/utils/env')

  async function useKeys(id: string, key: string, previous?: string) {
    process.env.MASTER_KEY_ID = id
    process.env.MASTER_KEY = key
    if (previous) process.env.MASTER_KEYS_PREVIOUS = previous
    else delete process.env.MASTER_KEYS_PREVIOUS
    envm.resetEnvCache()
    crypto.resetKeyring()
  }

  beforeAll(async () => {
    process.env.MASTER_KEY = K1
    process.env.MASTER_KEY_ID = 'k1'
    await setupTestDatabase('rekey')
    dbm = await import('../../server/db/client')
    crypto = await import('../../server/utils/crypto')
    envm = await import('../../server/utils/env')
    await useKeys('k1', K1)
    for (const v of ['token-portainer', 'secret-oidc', 'webhook']) {
      const { envelope, keyId } = crypto.encryptSecret(v)
      await dbm.db().insert(dbm.schema.secrets).values({ purpose: `test_${v}`, envelope, keyId })
    }
  }, 30_000)

  afterAll(async () => {
    await (await import('../../server/queue/redis')).closeRedis().catch(() => {})
    await dbm?.closeDb()
  })

  it('aperçu sans rien modifier, puis rechiffrement complet et lisible avec la nouvelle clé seule', async () => {
    const { rekeyAll } = await import('../../server/services/rekey')
    await useKeys('k2', K2, `k1:${K1}`)
    const preview = await rekeyAll({ dryRun: true })
    expect(preview).toMatchObject({ currentKeyId: 'k2', total: 3, toRotate: 3, rotated: 0, byKey: { k1: 3 } })
    const done = await rekeyAll({ dryRun: false })
    expect(done).toMatchObject({ toRotate: 3, rotated: 3, unreadable: [] })
    expect((await rekeyAll({ dryRun: false })).toRotate).toBe(0)

    // L'ancienne clé retirée : tout reste lisible.
    await useKeys('k2', K2)
    const rows = await dbm.db().select().from(dbm.schema.secrets)
    expect(rows.every(r => r.keyId === 'k2')).toBe(true)
    expect(rows.map(r => crypto.decryptSecret(r.envelope)).sort()).toEqual(['secret-oidc', 'token-portainer', 'webhook'])
  })

  it('signale les secrets chiffrés avec une clé absente du trousseau', async () => {
    const { rekeyAll } = await import('../../server/services/rekey')
    await useKeys('k1', K1)
    const { envelope, keyId } = crypto.encryptSecret('orphelin')
    await dbm.db().insert(dbm.schema.secrets).values({ purpose: 'test_orphelin', envelope, keyId })
    await useKeys('k2', K2)
    const r = await rekeyAll({ dryRun: false })
    expect(r.unreadable).toHaveLength(1)
    expect(r.unreadable[0]).toMatchObject({ keyId: 'k1', purpose: 'test_orphelin' })
  })
})
