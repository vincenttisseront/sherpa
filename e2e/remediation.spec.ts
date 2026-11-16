/**
 * Demandes de correction depuis la page Vulnérabilités (faux GitHub de la stack de dev) :
 * PR sur le code source (version épinglée d'un requirements vulnérable), issue sur l'image
 * construite, suivi d'une issue existante, état GitHub synchronisé (PR fusionnée), puis résolution
 * constatée par l'analyse de la release reconstruite.
 */
import type { Server } from 'node:http'
import type { APIRequestContext } from '@playwright/test'
import { type MockRepo, createMockGithub, filesFromDir } from '../scripts/mock-github'
import { expect, test } from './fixtures'

const API = 'http://host.docker.internal:18300'
const SLUG = 'e2e-correction'
const NAME = 'E2E correction'
const base = filesFromDir('e2e/fixtures/gh-app')
const repo: MockRepo & { issues: NonNullable<MockRepo['issues']>, pulls: NonNullable<MockRepo['pulls']>, branches: NonNullable<MockRepo['branches']> } = {
  files: { ...base, 'requirements.txt': 'requests==2.19.0\n' },
  issues: [],
  pulls: [],
  branches: {},
}
let server: Server

test.skip(!!process.env.E2E_BASE_URL && !process.env.E2E_GITHUB_MOCK, 'Faux GitHub joignable uniquement depuis la stack de développement')

test.beforeAll(async () => {
  server = createMockGithub({ 'acme/secure': repo })
  await new Promise<void>(r => server.listen(18300, '0.0.0.0', r))
})
test.afterAll(() => server?.close())

async function api<T>(request: APIRequestContext, method: 'get' | 'post' | 'put', url: string, data?: unknown): Promise<T> {
  const { csrfToken } = await (await request.get('/api/auth/me')).json() as { csrfToken: string }
  const res = await request[method](url, { data, headers: { 'x-csrf-token': csrfToken } })
  expect(res.status(), await res.text()).toBeLessThan(300)
  return res.json() as Promise<T>
}
const status = async (request: APIRequestContext, id: string) => ((await (await request.get(`/api/deployments/${id}`)).json()) as { status: string }).status

test('demandes de correction : PR, issue, suivi, fusion et résolution', async ({ page, request }) => {
  test.setTimeout(900_000)
  const existing = (await (await request.get(`/api/projects?q=${SLUG}&archived=all`)).json() as { items: { id: string, slug: string, archivedAt: string | null }[] }).items.find(p => p.slug === SLUG)
  if (existing?.archivedAt) await api(request, 'post', `/api/projects/${existing.id}/archive`, { archived: false })
  const p = existing ?? await api<{ id: string }>(request, 'post', '/api/projects', { slug: SLUG, name: NAME })
  const opts = await (await request.get('/api/deploy-options')).json() as { endpointId: string, environments: { key: string }[] }[]
  const o = opts.find(x => x.environments.some(e => e.key === 'staging'))!
  let detail = await (await request.get(`/api/projects/${p.id}`)).json() as { targets: { id: string }[] }
  if (!detail.targets.length) await api(request, 'post', `/api/projects/${p.id}/targets`, { endpointId: o.endpointId, environmentKey: 'staging' })
  detail = await (await request.get(`/api/projects/${p.id}`)).json() as typeof detail
  const tid = detail.targets[0]!.id
  await api(request, 'put', `/api/targets/${tid}/auto-rebuild`, { enabled: false, cleanBuild: false })
  await api(request, 'put', `/api/projects/${p.id}/source`, { kind: 'github', apiUrl: API, repository: 'acme/secure', composePath: 'compose.yml', refType: 'branch', ref: 'main' })
  try {
    // Déploiement : image construite et code source analysés avant le déploiement.
    const d = await api<{ deploymentId: string }>(request, 'post', `/api/targets/${tid}/deployments`, { source: 'github', refType: 'branch', ref: 'main', portApprovals: [] })
    await expect.poll(() => status(request, d.deploymentId), { timeout: 300_000 }).toMatch(/HEALTHY|FAILED|DEGRADED/)
    expect(await status(request, d.deploymentId)).toBe('HEALTHY')
    type Vulns = { images: { id: string, image: string, targets: { targetId: string }[] }[], sources: { id: string, targetId: string }[], requests: { kind: string, number: number, state: string, subjectKey: string }[] }
    const vulns = async () => api<Vulns>(request, 'get', '/api/vulnerabilities')
    const v = await vulns()
    const source = v.sources.find(x => x.targetId === tid)!
    const image = v.images.find(x => x.image.startsWith(`platform/${SLUG}-web:`) && x.targets.some(t => t.targetId === tid))!
    expect(source && image).toBeTruthy()

    // 1. PR sur le code source : requirements.txt monté à la version corrigée.
    await page.goto('/vulnerabilities')
    await page.getByRole('tab', { name: /Code source/ }).click({ timeout: 30_000 })
    await page.getByRole('button', { name: `Demande de correction pour le code source de ${NAME} (Staging)` }).click({ timeout: 30_000 })
    const dialog = page.getByRole('dialog')
    await expect(dialog.getByLabel('Dépôt GitHub')).toHaveValue('acme/secure', { timeout: 30_000 })
    await expect(dialog.getByText('Détecté : source GitHub du projet')).toBeVisible()
    await expect(dialog.getByText(/requests 2\.19\.0 → 2\.\d+\.\d+/)).toBeVisible({ timeout: 30_000 })
    await expect(dialog.getByRole('radio', { name: /Pull request/ })).toBeChecked()
    await expect(dialog.getByLabel('Texte (Markdown)')).toHaveValue(/\| requirements\.txt \| requests \| 2\.19\.0 \|/)
    await dialog.getByLabel('Jeton pour cette demande (non conservé)').fill('ghp_jeton_de_test_e2e_0123456789', { timeout: 30_000 })
    await dialog.getByRole('button', { name: 'Créer la PR' }).click({ timeout: 30_000 })
    await expect(dialog.getByText(/PR #1 ouverte sur acme\/secure/)).toBeVisible({ timeout: 30_000 })
    const pr = repo.pulls[0]!
    expect(pr).toMatchObject({ number: 1, base: 'main', state: 'open' })
    expect(pr.title).toMatch(/^Sécurité : corriger \d+ vulnérabilité\(s\) critique\(s\) et haute\(s\) des dépendances \(acme\/secure@main\)$/)
    expect(repo.branches[pr.head]!['requirements.txt']).toMatch(/^requests==2\.(?!19\.0)\d+\.\d+\n$/)
    await dialog.getByText('Fermer', { exact: true }).click({ timeout: 30_000 })

    // 2. Issue sur l'image construite (vulnérabilités de toutes sévérités, jeton saisi).
    await page.getByRole('tab', { name: /Images/ }).click({ timeout: 30_000 })
    await page.getByRole('button', { name: `Demande de correction pour ${image.image}` }).click({ timeout: 30_000 })
    await expect(dialog.getByLabel('Dépôt GitHub')).toHaveValue('acme/secure', { timeout: 30_000 })
    await dialog.getByLabel('Vulnérabilités').selectOption('LOW', { timeout: 30_000 })
    await expect(dialog.getByRole('radio', { name: 'Issue' })).toBeChecked({ timeout: 30_000 })
    await expect(dialog.getByLabel('Texte (Markdown)')).toHaveValue(/dans l'image `platform\/e2e-correction-web:/)
    await dialog.getByLabel('Jeton pour cette demande (non conservé)').fill('ghp_jeton_de_test_e2e_0123456789', { timeout: 30_000 })
    await dialog.getByRole('button', { name: 'Créer l\'issue' }).click({ timeout: 30_000 })
    await expect(dialog.getByText(/Issue #2 ouverte sur acme\/secure/)).toBeVisible({ timeout: 30_000 })
    expect(repo.issues.find(i => i.number === 2)!.title).toContain(`l'image platform/${SLUG}-web:`)
    await dialog.getByText('Fermer', { exact: true }).click({ timeout: 30_000 })

    // 3. Suivi d'une issue ouverte à la main sur GitHub.
    repo.issues.push({ number: 99, title: 'Mettre à jour requests', body: '', state: 'open' })
    const tracked = await api<{ number: number, state: string }>(request, 'post', '/api/vulnerabilities/remediation/track', { subject: { type: 'source', id: source.id }, url: `${API}/acme/secure/issues/99` })
    expect(tracked).toMatchObject({ number: 99, state: 'open' })

    // 4. PR fusionnée (la branche principale avance), issue fermée : état synchronisé.
    pr.merged = true
    pr.state = 'closed'
    repo.files = { ...repo.branches[pr.head]! }
    repo.issues.find(i => i.number === 99)!.state = 'closed'
    await api(request, 'post', '/api/vulnerabilities/remediation/sync')
    const states = async () => Object.fromEntries((await vulns()).requests.map(r => [r.number, r.state]))
    expect(await states()).toMatchObject({ 1: 'merged', 2: 'open', 99: 'closed' })

    // 5. Reconstruction sur le commit corrigé : la PR est résolue (analyse du code source).
    const rb = await api<{ deploymentId: string }>(request, 'post', `/api/targets/${tid}/rebuild`, { cleanBuild: false })
    await expect.poll(() => status(request, rb.deploymentId), { timeout: 300_000 }).toMatch(/HEALTHY|FAILED|DEGRADED/)
    expect(await status(request, rb.deploymentId)).toBe('HEALTHY')
    expect(await states()).toMatchObject({ 1: 'resolved', 2: 'open' })
    await page.goto('/vulnerabilities')
    await page.getByRole('tab', { name: /Code source/ }).click()
    await expect(page.getByRole('row', { name: new RegExp(NAME) }).getByText('PR #1 résolue')).toBeVisible({ timeout: 30_000 })
  }
  finally {
    const t = ((await (await request.get(`/api/projects/${p.id}`)).json()) as { targets: { id: string, currentRelease: unknown }[] }).targets[0]
    if (t?.currentRelease) {
      const del = await api<{ deploymentId: string }>(request, 'post', `/api/targets/${t.id}/actions`, { action: 'delete' }).catch(() => null)
      if (del) await expect.poll(() => status(request, del.deploymentId), { timeout: 120_000 }).toBe('DELETED').catch(() => {})
    }
    await api(request, 'post', `/api/projects/${p.id}/archive`, { archived: true }).catch(() => {})
  }
})
