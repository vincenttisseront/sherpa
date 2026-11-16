/** Assistant d'initialisation : état par défaut, progression, fin, reprise. */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { databaseAvailable, setupTestDatabase } from '../helpers/db'

const available = await databaseAvailable()

describe.skipIf(!available)('assistant d\'initialisation', () => {
  let dbm: typeof import('../../server/db/client')
  let mod: typeof import('../../server/services/onboarding')
  const user = { id: null, email: 'admin@test' }

  beforeAll(async () => {
    await setupTestDatabase('onboarding')
    dbm = await import('../../server/db/client')
    mod = await import('../../server/services/onboarding')
  }, 30_000)
  afterAll(async () => {
    await (await import('../../server/queue/redis')).closeRedis().catch(() => {})
    await dbm?.closeDb()
  })

  it('instance vierge : assistant à faire ; progression, fin et reprise tracées', async () => {
    expect((await mod.getOnboarding()).status).toBe('pending')
    expect(await mod.onboardingPending()).toBe(true)
    await mod.setStep('checks', 'done', user)
    const s = await mod.setStep('sso', 'skipped', user)
    expect(s).toMatchObject({ status: 'pending', steps: { checks: 'done', sso: 'skipped' } })
    expect((await mod.finish('dismissed', user)).status).toBe('dismissed')
    expect(await mod.onboardingPending()).toBe(false)
    expect((await mod.reopen(user)).status).toBe('pending')
    const done = await mod.finish('completed', user)
    expect(done).toMatchObject({ status: 'completed', steps: { checks: 'done', sso: 'skipped' } })
    // Une étape refaite après la fin ne rouvre pas l'assistant.
    expect((await mod.setStep('github', 'done', user)).status).toBe('completed')
    const actions = (await dbm.db().select({ a: dbm.schema.auditEvents.action }).from(dbm.schema.auditEvents)).map(r => r.a)
    expect(actions).toEqual(expect.arrayContaining(['onboarding.step', 'onboarding.dismissed', 'onboarding.reopened', 'onboarding.completed']))
  })

  it('installation existante déjà configurée (serveur déclaré) : pas d\'assistant imposé', async () => {
    await dbm.db().delete(dbm.schema.appSettings)
    const { encryptSecret } = await import('../../server/utils/crypto')
    const { envelope, keyId } = encryptSecret('t')
    const [sec] = await dbm.db().insert(dbm.schema.secrets).values({ purpose: 'portainer_token', envelope, keyId }).returning()
    await dbm.db().insert(dbm.schema.portainerServers).values({ name: 'existant', url: 'https://portainer.test', tokenSecretId: sec!.id } as never)
    expect((await mod.getOnboarding()).status).toBe('completed')
  })

  it('état des domaines pour guider la saisie (groupes, administrateurs, API GitHub)', async () => {
    const f = await mod.onboardingFacts()
    expect(f.roles.map(r => r.key).sort()).toEqual(['admin', 'creator', 'viewer'])
    expect(f.githubApis.length).toBeGreaterThan(0)
    expect(f.checks.map(c => c.key)).toEqual(expect.arrayContaining(['https', 'cookie', 'worker', 'keys']))
  })
})
