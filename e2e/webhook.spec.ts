/**
 * Déploiement au push GitHub (faux GitHub de la stack de dev) : webhook signé, livraisons ignorées
 * (autre branche, [skip deploy], doublon), déploiement de l'environnement qui suit la branche,
 * statut publié sur GitHub (API Deployments), puis « déjà à jour » sans nouveau commit.
 */
import { createHmac } from 'node:crypto'
import type { Server } from 'node:http'
import type { APIRequestContext } from '@playwright/test'
import { type MockRepo, createMockGithub, filesFromDir } from '../scripts/mock-github'
import { expect, test } from './fixtures'

const API = 'http://host.docker.internal:18300'
const SLUG = 'e2e-webhook'
const repo: MockRepo = { files: { ...filesFromDir('e2e/fixtures/gh-app') } }
let server: Server

test.skip(!!process.env.E2E_BASE_URL && !process.env.E2E_GITHUB_MOCK, 'Faux GitHub joignable uniquement depuis la stack de développement')
test.beforeAll(async () => {
  server = createMockGithub({ 'acme/hook': repo })
  await new Promise<void>(r => server.listen(18300, '0.0.0.0', r))
})
test.afterAll(() => server?.close())

async function api<T>(request: APIRequestContext, method: 'get' | 'post' | 'put' | 'delete', url: string, data?: unknown): Promise<T> {
  const { csrfToken } = await (await request.get('/api/auth/me')).json() as { csrfToken: string }
  const res = await request[method](url, { data, headers: { 'x-csrf-token': csrfToken } })
  expect(res.status(), await res.text()).toBeLessThan(300)
  return res.json() as Promise<T>
}
const status = async (request: APIRequestContext, id: string) => ((await (await request.get(`/api/deployments/${id}`)).json()) as { status: string }).status

test('webhook GitHub : push signé → déploiement, statut sur GitHub, doublons et refus', async ({ page, request }) => {
  test.setTimeout(900_000)
  const existing = (await (await request.get(`/api/projects?q=${SLUG}&archived=all`)).json() as { items: { id: string, slug: string, archivedAt: string | null }[] }).items.find(p => p.slug === SLUG)
  if (existing?.archivedAt) await api(request, 'post', `/api/projects/${existing.id}/archive`, { archived: false })
  const p = existing ?? await api<{ id: string }>(request, 'post', '/api/projects', { slug: SLUG, name: 'E2E webhook' })
  const opts = await (await request.get('/api/deploy-options')).json() as { endpointId: string, environments: { key: string }[] }[]
  const o = opts.find(x => x.environments.some(e => e.key === 'staging'))!
  let detail = await (await request.get(`/api/projects/${p.id}`)).json() as { targets: { id: string }[] }
  if (!detail.targets.length) await api(request, 'post', `/api/projects/${p.id}/targets`, { endpointId: o.endpointId, environmentKey: 'staging' })
  detail = await (await request.get(`/api/projects/${p.id}`)).json() as typeof detail
  const tid = detail.targets[0]!.id
  await api(request, 'put', `/api/targets/${tid}/auto-rebuild`, { enabled: false, cleanBuild: false })
  await api(request, 'put', `/api/projects/${p.id}/source`, { kind: 'github', apiUrl: API, repository: 'acme/hook', composePath: 'compose.yml', refType: 'branch', ref: 'main', token: 'ghp_jeton_de_test_e2e_0123456789' })
  const url = `/api/webhooks/github/${p.id}`
  await api(request, 'delete', `/api/projects/${p.id}/webhook`)
  await api(request, 'put', `/api/targets/${tid}/webhook`, { enabled: false, branch: null, cleanBuild: false })
  const deliver = async (event: string, body: unknown, o: { guid?: string, secret?: string } = {}) => {
    const raw = JSON.stringify(body)
    const sig = `sha256=${createHmac('sha256', o.secret ?? secret).update(raw).digest('hex')}`
    return request.post(url, { data: raw, headers: { 'content-type': 'application/json', 'x-github-event': event, 'x-github-delivery': o.guid ?? crypto.randomUUID(), 'x-hub-signature-256': sig } })
  }
  const push = (branch: string, sha: string, message = 'maj') => ({ ref: `refs/heads/${branch}`, after: sha, deleted: false, repository: { full_name: 'acme/hook' }, head_commit: { message } })
  let secret = ''
  try {
    // Premier déploiement (manuel), puis webhook.
    const first = await api<{ deploymentId: string }>(request, 'post', `/api/targets/${tid}/deployments`, { source: 'github', refType: 'branch', ref: 'main', portApprovals: [] })
    await expect.poll(() => status(request, first.deploymentId), { timeout: 300_000 }).toMatch(/HEALTHY|FAILED|DEGRADED/)
    expect(await status(request, first.deploymentId)).toBe('HEALTHY')

    // Sans secret : aucune livraison acceptée, rien n'est révélé.
    expect((await request.post(url, { data: '{}', headers: { 'content-type': 'application/json', 'x-github-event': 'ping' } })).status()).toBe(404)
    const created = await api<{ url: string, secret: string }>(request, 'post', `/api/projects/${p.id}/webhook`)
    secret = created.secret
    expect(secret).toMatch(/^[0-9a-f]{64}$/)
    expect(created.url).toMatch(new RegExp(`/api/webhooks/github/${p.id}$`))
    const view = await api<{ configured: boolean, statusReporting: string }>(request, 'get', `/api/projects/${p.id}/webhook`)
    expect(view.configured).toBe(true)
    expect(JSON.stringify(view)).not.toContain(secret)
    expect(view.statusReporting).toBe('token')

    // Signature : refusée si fausse ; ping accepté.
    expect((await deliver('ping', { zen: 'x' }, { secret: 'f'.repeat(64) })).status()).toBe(401)
    expect(await (await deliver('ping', { zen: 'x' })).json()).toEqual({ pong: true })

    // Environnement pas encore activé : livraison ignorée.
    const sha1 = 'a'.repeat(40)
    expect(await (await deliver('push', push('main', sha1))).json()).toMatchObject({ ignored: expect.stringContaining('activé') })
    await api(request, 'put', `/api/targets/${tid}/webhook`, { enabled: true, branch: null, cleanBuild: false })

    // Ignorés : autre branche, [skip deploy], tag, doublon.
    expect(await (await deliver('push', push('feature/x', sha1))).json()).toMatchObject({ ignored: expect.stringContaining('feature/x') })
    expect(await (await deliver('push', push('main', sha1, 'wip [skip deploy]'))).json()).toMatchObject({ ignored: expect.stringContaining('skip deploy') })
    expect(await (await deliver('push', { ...push('main', sha1), ref: 'refs/tags/v1' })).json()).toMatchObject({ ignored: expect.stringContaining('tag') })
    expect(await (await deliver('issues', { action: 'opened' })).json()).toMatchObject({ ignored: expect.stringContaining('non géré') })

    // Déjà à jour : le commit de la branche est celui qui est déployé.
    const same = await deliver('push', push('main', sha1))
    expect(same.status()).toBe(202)
    const results = async () => (await api<{ deliveries: { outcome: string, results: { outcome: string, deploymentId?: string, message?: string }[] }[] }>(request, 'get', `/api/projects/${p.id}/webhook`)).deliveries
    await expect.poll(async () => (await results())[0]!.outcome, { timeout: 120_000, intervals: [2000] }).toBe('done')
    expect((await results())[0]!.results[0]).toMatchObject({ outcome: 'up-to-date' })

    // Nouveau commit sur main : déploiement lancé, statut publié sur GitHub.
    repo.files = { ...repo.files, 'Dockerfile': `${repo.files.Dockerfile}\n# nouveau commit du webhook\n` }
    const guid = crypto.randomUUID()
    const hit = await deliver('push', push('main', 'c'.repeat(40), 'feat: nouveau'), { guid })
    expect(hit.status()).toBe(202)
    expect(await (await deliver('push', push('main', 'c'.repeat(40), 'feat: nouveau'), { guid })).json()).toEqual({ duplicate: true })
    let deploymentId = ''
    await expect.poll(async () => {
      const d = (await results())[0]!
      deploymentId = d.results[0]?.deploymentId ?? ''
      return d.outcome
    }, { timeout: 120_000, intervals: [2000] }).toBe('done')
    expect(deploymentId).not.toBe('')
    await expect.poll(() => status(request, deploymentId), { timeout: 300_000 }).toMatch(/HEALTHY|FAILED|DEGRADED/)
    expect(await status(request, deploymentId)).toBe('HEALTHY')
    // Statuts GitHub : en file ou en cours, puis réussi, avec le lien vers le déploiement.
    await expect.poll(() => repo.deployments?.[0]?.statuses.map(s => s.state).at(-1), { timeout: 60_000, intervals: [1000] }).toBe('success')
    const gh = repo.deployments![0]!
    expect(gh).toMatchObject({ environment: 'staging', production: false })
    const states = gh.statuses.map(s => s.state)
    expect(['queued', 'in_progress']).toContain(states[0])
    expect(states.at(-1)).toBe('success')
    expect(states).not.toContain('failure')
    expect(gh.statuses.every(s => s.logUrl?.endsWith(`/deployments/${deploymentId}`))).toBe(true)

    // Interface : adresse, livraisons reçues, réglage par environnement ; le secret n'est jamais réaffiché.
    await page.goto(`/projects/${p.id}?tab=source`)
    await expect(page.getByTestId('webhook-url')).toContainText(`/api/webhooks/github/${p.id}`, { timeout: 30_000 })
    await expect(page.getByTestId('webhook-secret')).toHaveCount(0)
    await expect(page.getByRole('button', { name: 'Remplacer le secret…' })).toBeVisible()
    await expect(page.getByLabel('Déploiement au push pour Staging')).toBeChecked()
    await expect(page.getByRole('row', { name: /push.*main.*traitée/ }).first()).toBeVisible()
    await expect(page.getByText('déploiement lancé').first()).toBeVisible()
    await expect(page.getByText('ignorée').first()).toBeVisible()
    await page.getByRole('button', { name: 'Remplacer le secret…' }).click()
    await page.getByRole('dialog').getByRole('button', { name: 'Remplacer' }).click()
    const shown = await page.getByTestId('webhook-secret').textContent({ timeout: 30_000 })
    expect(shown).toMatch(/^[0-9a-f]{64}$/)
    expect(shown).not.toBe(secret)
    // Ancien secret refusé, nouveau accepté.
    secret = shown!
    expect((await deliver('ping', { zen: 'x' }, { secret: created.secret })).status()).toBe(401)
    expect((await deliver('ping', { zen: 'x' })).status()).toBe(200)

    // Webhook supprimé : livraisons refusées.
    await api(request, 'delete', `/api/projects/${p.id}/webhook`)
    expect((await request.post(url, { data: '{}', headers: { 'content-type': 'application/json', 'x-github-event': 'ping' } })).status()).toBe(404)
  }
  finally {
    await api(request, 'delete', `/api/projects/${p.id}/webhook`).catch(() => null)
    const t = ((await (await request.get(`/api/projects/${p.id}`)).json()) as { targets: { id: string, currentRelease: unknown }[] }).targets[0]
    if (t?.currentRelease) {
      const del = await api<{ deploymentId: string }>(request, 'post', `/api/targets/${t.id}/actions`, { action: 'delete' }).catch(() => null)
      if (del) await expect.poll(() => status(request, del.deploymentId), { timeout: 120_000 }).toBe('DELETED').catch(() => {})
    }
    await api(request, 'post', `/api/projects/${p.id}/archive`, { archived: true }).catch(() => {})
  }
})
