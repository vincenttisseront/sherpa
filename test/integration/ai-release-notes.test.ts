/**
 * Notes de version par Ollama : dépôt GitHub déduit de l'image, releases lues sur un faux GitHub,
 * contexte réellement envoyé au modèle (simulé). Aucune release entre les deux versions : le modèle
 * n'est pas appelé.
 */
import type { Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { eq } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { OLLAMA_FEATURE_KEYS } from '../../shared/schemas/ollama'
import { createMockGithub } from '../../scripts/mock-github'
import { databaseAvailable, setupTestDatabase } from '../helpers/db'

const available = await databaseAvailable()

describe.skipIf(!available)('notes de version (base de test, GitHub et modèle simulés)', () => {
  let gh: Server
  let dbm: typeof import('../../server/db/client')
  let mod: typeof import('../../server/services/ai-release-notes')
  let getTarget: typeof import('../../server/services/projects')['getTargetOr404']
  let mock: import('../../server/adapters/ollama').MockOllamaAdapter
  let envMod: typeof import('../../server/utils/env')
  let targetId: string

  beforeAll(async () => {
    gh = createMockGithub({
      'acme/shop': {
        files: { 'a': '1' },
        releases: [
          { tag: 'v1.3.0', files: { a: '3' }, body: '## 1.3.0\n- Nouvelle API' },
          { tag: 'v1.2.0', files: { a: '2' }, body: '## 1.2.0\n- **Breaking** : variable `OLD_URL` renommée en `APP_URL`\n<!-- note interne à ne pas envoyer -->\n- migration de la base requise (password=hunter2hunter2)' },
          { tag: 'v1.1.0', files: { a: '1' }, body: '## 1.1.0\n- version en service' },
        ],
      },
    })
    await new Promise<void>(r => gh.listen(0, '127.0.0.1', r))
    process.env.GITHUB_ALLOWED_API_URLS = `http://127.0.0.1:${(gh.address() as AddressInfo).port}`
    process.env.OLLAMA_ADAPTER = 'mock'
    await setupTestDatabase('release_notes')
    envMod = await import('../../server/utils/env')
    envMod.resetEnvCache()
    dbm = await import('../../server/db/client')
    mod = await import('../../server/services/ai-release-notes')
    getTarget = (await import('../../server/services/projects')).getTargetOr404
    const svc = await import('../../server/services/ollama')
    await svc.saveOllamaSettings({ enabled: true, baseUrl: 'http://ollama:11434', model: 'llama3.1:8b', timeoutSec: 60, contextTokens: 8192, features: [...OLLAMA_FEATURE_KEYS], clearToken: false }, null)
    mock = (await import('../../server/adapters/ollama')).ollama() as typeof mock

    const { encryptSecret } = await import('../../server/utils/crypto')
    const { envelope, keyId } = encryptSecret('t')
    const [sec] = await dbm.db().insert(dbm.schema.secrets).values({ purpose: 'agent_secret', envelope, keyId }).returning()
    const [server] = await dbm.db().insert(dbm.schema.portainerServers).values({ name: 's', url: 'https://p.test', tokenSecretId: sec!.id } as never).returning()
    const [ep] = await dbm.db().insert(dbm.schema.serverEndpoints).values({ serverId: server!.id, portainerEndpointId: 1, name: 'local', type: 'docker_standalone', enabled: true } as never).returning()
    const [env] = await dbm.db().select().from(dbm.schema.environments).where(eq(dbm.schema.environments.key, 'staging'))
    const [p] = await dbm.db().insert(dbm.schema.projects).values({ slug: 'shop', name: 'Shop' }).returning()
    const [t] = await dbm.db().insert(dbm.schema.projectTargets).values({ projectId: p!.id, endpointId: ep!.id, environmentId: env!.id, stackName: 'shop-staging', portainerStackId: 3 } as never).returning()
    const images = { shop: 'ghcr.io/acme/shop:1.1.0', web: 'nginx:latest' }
    const [rel] = await dbm.db().insert(dbm.schema.releases).values({ targetId: t!.id, number: 1, sourceKind: 'zip', slug: 'r-0001-aaaaaa', composePath: 'compose.yml', composeSource: 'services: {}\n', composeFinal: 'services: {}\n', images } as never).returning()
    await dbm.db().update(dbm.schema.projectTargets).set({ currentReleaseId: rel!.id }).where(eq(dbm.schema.projectTargets.id, t!.id))
    targetId = t!.id
  })
  afterAll(async () => {
    gh?.close()
    delete process.env.GITHUB_ALLOWED_API_URLS
    delete process.env.OLLAMA_ADAPTER
    envMod?.resetEnvCache()
    await dbm?.closeDb()
  })

  const lastPrompt = () => mock.calls.at(-1)!.req.messages.map(m => m.content).join('\n')

  it('envoie au modèle les notes des releases entre les deux versions, nettoyées et masquées', async () => {
    mock.calls.length = 0
    mock.reply = JSON.stringify({ severity: 'warning', summary: 'Variable renommée.', causes: [{ title: 'OLD_URL renommée', evidence: 'v1.2.0' }], actions: ['Renommer la variable'] })
    const r = await mod.explainReleaseNotes(await getTarget(targetId), { service: 'shop', tag: '1.3.0' })
    const sent = lastPrompt()
    expect(sent).toContain('mise à niveau de 1.1.0 vers 1.3.0')
    expect(sent).toContain('acme/shop (déduit du nom de l\'image)')
    expect(sent).toContain('OLD_URL')
    expect(sent).toContain('Nouvelle API')
    expect(sent).not.toContain('## 1.1.0')
    expect(sent).not.toContain('note interne')
    expect(sent).not.toContain('hunter2hunter2')
    expect(r).toMatchObject({ severity: 'warning', causes: [{ title: 'OLD_URL renommée' }] })
  })

  it('ne rappelle pas le modèle quand aucune release ne sépare les versions', async () => {
    mock.calls.length = 0
    await expect(mod.explainReleaseNotes(await getTarget(targetId), { service: 'shop', tag: '1.1.0' })).rejects.toMatchObject({ statusCode: 422, statusMessage: expect.stringContaining('Aucune release') })
    expect(mock.calls).toHaveLength(0)
  })

  it('refuse un service inconnu, un tag flottant et une image sans dépôt connu', async () => {
    mock.calls.length = 0
    const t = await getTarget(targetId)
    await expect(mod.explainReleaseNotes(t, { service: 'absent', tag: '1.3.0' })).rejects.toMatchObject({ statusCode: 404 })
    await expect(mod.explainReleaseNotes(t, { service: 'web', tag: '1.27' })).rejects.toMatchObject({ statusCode: 422 })
    await expect(mod.explainReleaseNotes(t, { service: 'shop', tag: 'latest' })).rejects.toMatchObject({ statusCode: 422 })
    expect(mock.calls).toHaveLength(0)
  })
})
