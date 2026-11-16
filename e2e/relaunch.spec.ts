/**
 * Relance d'un déploiement depuis sa page, avec les mêmes paramètres (même release) :
 * sans reconstruction (images construites reprises), puis avec reconstruction.
 */
import type { Server } from 'node:http'
import type { APIRequestContext } from '@playwright/test'
import { createMockGithub, filesFromDir } from '../scripts/mock-github'
import { expect, test } from './fixtures'

const API = 'http://host.docker.internal:18300'
const SLUG = 'e2e-relance'
let server: Server

test.skip(!!process.env.E2E_BASE_URL && !process.env.E2E_GITHUB_MOCK, 'Faux GitHub joignable uniquement depuis la stack de développement')

test.beforeAll(async () => {
  server = createMockGithub({ 'acme/relance': { files: filesFromDir('e2e/fixtures/gh-app') } })
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

test('relance d\'un déploiement : sans puis avec reconstruction des images', async ({ page, request }) => {
  test.setTimeout(900_000)
  const existing = (await (await request.get(`/api/projects?q=${SLUG}&archived=all`)).json() as { items: { id: string, slug: string, archivedAt: string | null }[] }).items.find(p => p.slug === SLUG)
  if (existing?.archivedAt) await api(request, 'post', `/api/projects/${existing.id}/archive`, { archived: false })
  const p = existing ?? await api<{ id: string }>(request, 'post', '/api/projects', { slug: SLUG, name: 'E2E relance' })
  const opts = await (await request.get('/api/deploy-options')).json() as { endpointId: string, environments: { key: string }[] }[]
  const o = opts.find(x => x.environments.some(e => e.key === 'staging'))!
  let detail = await (await request.get(`/api/projects/${p.id}`)).json() as { targets: { id: string }[] }
  if (!detail.targets.length) await api(request, 'post', `/api/projects/${p.id}/targets`, { endpointId: o.endpointId, environmentKey: 'staging' })
  detail = await (await request.get(`/api/projects/${p.id}`)).json() as typeof detail
  const tid = detail.targets[0]!.id
  await api(request, 'put', `/api/targets/${tid}/auto-rebuild`, { enabled: false, cleanBuild: false })
  await api(request, 'put', `/api/projects/${p.id}/source`, { kind: 'github', apiUrl: API, repository: 'acme/relance', composePath: 'compose.yml', refType: 'branch', ref: 'main' })
  try {
    const first = await api<{ deploymentId: string }>(request, 'post', `/api/targets/${tid}/deployments`, { source: 'github', refType: 'branch', ref: 'main', portApprovals: [] })
    await expect.poll(() => status(request, first.deploymentId), { timeout: 300_000 }).toMatch(/HEALTHY|FAILED|DEGRADED/)
    expect(await status(request, first.deploymentId)).toBe('HEALTHY')

    // 1. Relance sans reconstruction (option par défaut) : image construite reprise.
    await page.goto(`/deployments/${first.deploymentId}`)
    await page.getByRole('button', { name: 'Relancer…' }).click({ timeout: 30_000 })
    const dialog = page.getByRole('dialog')
    await expect(dialog.getByLabel('Reconstruire les images')).not.toBeChecked()
    await expect(dialog.getByLabel('Build propre')).toHaveCount(0)
    await dialog.getByRole('button', { name: 'Relancer', exact: true }).click()
    await page.waitForURL(u => !u.pathname.endsWith(first.deploymentId), { timeout: 30_000 })
    const second = page.url().split('/').pop()!
    await expect.poll(() => status(request, second), { timeout: 300_000 }).toMatch(/HEALTHY|FAILED|DEGRADED/)
    await page.reload()
    await expect(page.getByRole('log')).toContainText('Image reprise sans reconstruction')
    await expect(page.getByRole('log')).not.toContainText('Image construite en')
    expect(await status(request, second)).toBe('HEALTHY')
    await expect(page.getByText('images reprises sans reconstruction')).toBeVisible()

    // 2. Relance avec reconstruction : images construites à nouveau.
    await page.getByRole('button', { name: 'Relancer…' }).click({ timeout: 30_000 })
    await dialog.getByLabel('Reconstruire les images').check()
    await expect(dialog.getByLabel('Build propre')).toBeVisible()
    await dialog.getByRole('button', { name: 'Relancer', exact: true }).click()
    await page.waitForURL(u => !u.pathname.endsWith(second), { timeout: 30_000 })
    const third = page.url().split('/').pop()!
    await expect.poll(() => status(request, third), { timeout: 300_000 }).toMatch(/HEALTHY|FAILED|DEGRADED/)
    await page.reload()
    await expect(page.getByRole('log')).toContainText('Image construite en')
    expect(await status(request, third)).toBe('HEALTHY')
    // Même release relancée à chaque fois.
    const rel = async (id: string) => ((await (await request.get(`/api/deployments/${id}`)).json()) as { release: { id: string } }).release.id
    expect(new Set([await rel(first.deploymentId), await rel(second), await rel(third)]).size).toBe(1)
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
