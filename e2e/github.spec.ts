/**
 * Sources GitHub publique et privée, de bout en bout : la plateforme (dans Docker)
 * joint deux faux GitHub lancés par le test (dépôt public sans token ; dépôt privé
 * avec un token fine-grained généré ici), teste l'accès depuis l'interface, puis
 * construit et déploie chaque commit jusqu'aux healthchecks.
 */
import { randomBytes } from 'node:crypto'
import type { Server } from 'node:http'
import type { APIRequestContext, Page } from '@playwright/test'
import { createMockGithub, filesFromDir } from '../scripts/mock-github'
import { expect, test } from './fixtures'

const PUBLIC_API = 'http://host.docker.internal:18301'
const PRIVATE_API = 'http://host.docker.internal:18302'
const token = `github_pat_${randomBytes(24).toString('hex')}`
const files = filesFromDir('e2e/fixtures/gh-app')
let servers: Server[] = []

// Les faux GitHub doivent être joignables par la plateforme (stack de dev) : ignoré ailleurs.
test.skip(!!process.env.E2E_BASE_URL && !process.env.E2E_GITHUB_MOCK, 'Faux GitHub joignable uniquement depuis la stack de développement')

test.beforeAll(async () => {
  servers = [
    createMockGithub({ 'acme/app-publique': { files } }),
    createMockGithub({ 'acme/app-privee': { files, private: true } }, { tokens: { [token]: { repos: ['acme/app-privee'] } } }),
  ]
  await Promise.all(servers.map((s, i) => new Promise<void>(r => s.listen(18301 + i, '0.0.0.0', r))))
})
// Fin du test : stacks déployées supprimées par la plateforme (conteneurs, releases, images construites),
// puis projets archivés (masqués des listes ; désarchivés et réutilisés au prochain passage).
test.afterAll(async ({ playwright }) => {
  servers.forEach(s => s.close())
  const request = await playwright.request.newContext({ baseURL: process.env.E2E_BASE_URL ?? 'http://localhost:3100', storageState: '.data/e2e/admin.json' })
  try {
    for (const slug of ['e2e-gh-public', 'e2e-gh-prive']) {
      const p = (await (await request.get(`/api/projects?q=${slug}&archived=all`)).json() as { items: { id: string, slug: string, archivedAt: string | null }[] }).items.find(x => x.slug === slug)
      if (!p || p.archivedAt) continue
      const detail = await (await request.get(`/api/projects/${p.id}`)).json() as { targets: { id: string, stackName: string | null, currentRelease: unknown }[] }
      for (const t of detail.targets.filter(x => x.currentRelease)) {
        const { csrfToken } = await (await request.get('/api/auth/me')).json() as { csrfToken: string }
        const res = await request.post(`/api/targets/${t.id}/actions`, { data: { action: 'delete' }, headers: { 'x-csrf-token': csrfToken } })
        const { deploymentId } = await res.json() as { deploymentId: string }
        await expect.poll(async () => ((await (await request.get(`/api/deployments/${deploymentId}`)).json()) as { status: string }).status, { timeout: 120_000 }).toBe('DELETED')
      }
      const { csrfToken } = await (await request.get('/api/auth/me')).json() as { csrfToken: string }
      const archived = await request.post(`/api/projects/${p.id}/archive`, { data: { archived: true }, headers: { 'x-csrf-token': csrfToken } })
      expect(archived.ok()).toBe(true)
    }
  }
  finally {
    await request.dispose()
  }
})

async function api(request: APIRequestContext, method: 'post' | 'put', url: string, data: unknown) {
  const { csrfToken } = await (await request.get('/api/auth/me')).json() as { csrfToken: string }
  const res = await request[method](url, { data, headers: { 'x-csrf-token': csrfToken } })
  expect(res.status(), await res.text()).toBeLessThan(300)
  return res.json()
}

/** Projet + cible staging + source GitHub (token éventuel), par l'API. */
async function project(request: APIRequestContext, slug: string, source: Record<string, unknown>) {
  // Projet du passage précédent, archivé en fin de test : désarchivé pour être réutilisé.
  const existing = (await (await request.get(`/api/projects?q=${slug}&archived=all`)).json() as { items: { id: string, slug: string, archivedAt: string | null }[] }).items.find(p => p.slug === slug)
  if (existing?.archivedAt) await api(request, 'post', `/api/projects/${existing.id}/archive`, { archived: false })
  const p = existing ?? await api(request, 'post', '/api/projects', { slug, name: `E2E ${slug}` }) as { id: string }
  const opts = await (await request.get('/api/deploy-options')).json() as { endpointId: string, environments: { key: string }[] }[]
  const o = opts.find(x => x.environments.some(e => e.key === 'staging'))!
  const detail = await (await request.get(`/api/projects/${p.id}`)).json() as { targets: unknown[] }
  if (!detail.targets.length) await api(request, 'post', `/api/projects/${p.id}/targets`, { endpointId: o.endpointId, environmentKey: 'staging' })
  await api(request, 'put', `/api/projects/${p.id}/source`, { kind: 'github', refType: 'branch', ref: 'main', composePath: 'compose.yml', ...source })
  return p.id
}

async function testAccessAndDeploy(page: Page, projectId: string, expectBadge: string, expectAccess: RegExp) {
  await page.goto(`/projects/${projectId}`)
  await page.getByRole('tab', { name: 'Source' }).click()
  await page.getByRole('button', { name: 'Tester l\'accès' }).click()
  const result = page.locator('.test')
  await expect(result).toContainText(expectBadge)
  await expect(result).toContainText(expectAccess)
  await expect(result).toContainText('trouvé')

  await page.getByRole('button', { name: 'Nouveau déploiement' }).click()
  await page.getByRole('button', { name: 'Résoudre et analyser' }).click()
  await expect(page.getByRole('heading', { name: /Analyse/ })).toBeVisible({ timeout: 30_000 })
  await page.getByRole('button', { name: 'Déployer', exact: true }).click()
  await page.getByRole('dialog').getByRole('button', { name: 'Déployer' }).click()
  await expect(page).toHaveURL(/\/deployments\/[0-9a-f-]{36}$/)
  await expect(page.getByRole('log')).toContainText('Commit déployé', { timeout: 90_000 })
  await expect(page.getByRole('log')).toContainText('Statut : HEALTHY', { timeout: 180_000 })
}

test('dépôt public sans token : accès anonyme signalé, build et déploiement', async ({ page, request }) => {
  test.setTimeout(300_000)
  const id = await project(request, 'e2e-gh-public', { apiUrl: PUBLIC_API, repository: 'acme/app-publique', token: null })
  await testAccessAndDeploy(page, id, 'public', /anonyme.*60 appels/s)
})

test('dépôt privé : introuvable sans token, puis build et déploiement avec un token fine-grained', async ({ page, request }) => {
  test.setTimeout(300_000)
  const id = await project(request, 'e2e-gh-prive', { apiUrl: PRIVATE_API, repository: 'acme/app-privee', token: null })
  await page.goto(`/projects/${id}`)
  await page.getByRole('tab', { name: 'Source' }).click()
  await page.getByRole('button', { name: 'Tester l\'accès' }).click()
  await expect(page.getByText(/dépôt privé \(un token est alors nécessaire\)/)).toBeVisible()

  await project(request, 'e2e-gh-prive', { apiUrl: PRIVATE_API, repository: 'acme/app-privee', token })
  await testAccessAndDeploy(page, id, 'privé', /token fine-grained/)
})
