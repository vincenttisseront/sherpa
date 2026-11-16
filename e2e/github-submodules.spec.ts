/**
 * Dépôt GitHub avec deux sous-modules (faux GitHub de la stack de dev) : arbres lus et archives
 * téléchargées ensemble, taille et durée au journal, sources des sous-modules présentes sur l'hôte.
 */
import type { Server } from 'node:http'
import type { APIRequestContext } from '@playwright/test'
import { createMockGithub } from '../scripts/mock-github'
import { expect, test } from './fixtures'

const API = 'http://host.docker.internal:18300'
const SLUG = 'e2e-sousmodules'
const root = {
  files: {
    'compose.yml': 'services:\n  web:\n    image: busybox:1.37\n    command: ["sleep", "3600"]\n',
    '.gitmodules': '[submodule "libs/ui"]\n\tpath = libs/ui\n\turl = https://host.docker.internal/acme/ui.git\n[submodule "libs/api"]\n\tpath = libs/api\n\turl = https://host.docker.internal/acme/api.git\n',
  },
  submodules: { 'libs/ui': { repository: 'acme/ui' }, 'libs/api': { repository: 'acme/api' } },
}
let server: Server

test.skip(!!process.env.E2E_BASE_URL && !process.env.E2E_GITHUB_MOCK, 'Faux GitHub joignable uniquement depuis la stack de développement')
test.beforeAll(async () => {
  server = createMockGithub({ 'acme/avec-sous-modules': root, 'acme/ui': { files: { 'ui.txt': 'interface\n' } }, 'acme/api': { files: { 'api.txt': 'api\n' } } })
  await new Promise<void>(r => server.listen(18300, '0.0.0.0', r))
})
test.afterAll(() => server?.close())

async function api<T>(request: APIRequestContext, method: 'get' | 'post' | 'put', url: string, data?: unknown): Promise<T> {
  const { csrfToken } = await (await request.get('/api/auth/me')).json() as { csrfToken: string }
  const res = await request[method](url, { data, headers: { 'x-csrf-token': csrfToken } })
  expect(res.status(), await res.text()).toBeLessThan(300)
  return res.json() as Promise<T>
}

test('dépôt avec deux sous-modules : archives téléchargées ensemble', async ({ request }) => {
  test.setTimeout(600_000)
  const existing = (await (await request.get(`/api/projects?q=${SLUG}&archived=all`)).json() as { items: { id: string, slug: string, archivedAt: string | null }[] }).items.find(p => p.slug === SLUG)
  if (existing?.archivedAt) await api(request, 'post', `/api/projects/${existing.id}/archive`, { archived: false })
  const p = existing ?? await api<{ id: string }>(request, 'post', '/api/projects', { slug: SLUG, name: 'E2E sous-modules' })
  const opts = await (await request.get('/api/deploy-options')).json() as { endpointId: string, environments: { key: string }[] }[]
  const o = opts.find(x => x.environments.some(e => e.key === 'staging'))!
  let detail = await (await request.get(`/api/projects/${p.id}`)).json() as { targets: { id: string }[] }
  if (!detail.targets.length) await api(request, 'post', `/api/projects/${p.id}/targets`, { endpointId: o.endpointId, environmentKey: 'staging' })
  detail = await (await request.get(`/api/projects/${p.id}`)).json() as typeof detail
  const tid = detail.targets[0]!.id
  await api(request, 'put', `/api/targets/${tid}/auto-rebuild`, { enabled: false, cleanBuild: false })
  await api(request, 'put', `/api/projects/${p.id}/source`, { kind: 'github', apiUrl: API, repository: 'acme/avec-sous-modules', composePath: 'compose.yml', refType: 'branch', ref: 'main', submodules: true })
  try {
    // Analyse : les arbres des deux sous-modules sont lus.
    const preview = await api<{ submodules: { path: string, supported: boolean }[] }>(request, 'post', `/api/targets/${tid}/analyze-github`, { refType: 'branch', ref: 'main', portApprovals: [] })
    expect(preview.submodules.map(s => s.path).sort()).toEqual(['libs/api', 'libs/ui'])
    expect(preview.submodules.every(s => s.supported)).toBe(true)

    const d = await api<{ deploymentId: string }>(request, 'post', `/api/targets/${tid}/deployments`, { source: 'github', refType: 'branch', ref: 'main', portApprovals: [] })
    await expect.poll(async () => ((await (await request.get(`/api/deployments/${d.deploymentId}`)).json()) as { status: string }).status, { timeout: 300_000 }).toMatch(/HEALTHY|FAILED|DEGRADED/)
    const log = await (await request.get(`/api/deployments/${d.deploymentId}/logs?format=text`)).text()
    expect(log).toMatch(/Archive GitHub reçue et inspectée : \d+ fichiers, [\d.,]+ \S+ en [\d.]+ s/)
    expect(log).toMatch(/Sous-module libs\/ui \(acme\/ui@\w+\) : \d+ fichiers, .* en [\d.]+ s/)
    expect(log).toMatch(/Sous-module libs\/api \(acme\/api@\w+\) : \d+ fichiers, .* en [\d.]+ s/)
    expect(((await (await request.get(`/api/deployments/${d.deploymentId}`)).json()) as { status: string }).status).toBe('HEALTHY')
  }
  finally {
    const t = ((await (await request.get(`/api/projects/${p.id}`)).json()) as { targets: { id: string, currentRelease: unknown }[] }).targets[0]
    if (t?.currentRelease) await api(request, 'post', `/api/targets/${t.id}/actions`, { action: 'delete' }).catch(() => null)
    await api(request, 'post', `/api/projects/${p.id}/archive`, { archived: true }).catch(() => {})
  }
})
