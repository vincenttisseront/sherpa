/**
 * Builds et analyses Trivy d'un même déploiement en parallèle : trois images construites par un
 * dépôt GitHub (faux GitHub de la stack de dev), deux builds à la fois ; avec le blocage activé,
 * les analyses d'images tournent aussi avant le déploiement (la première seule, puis deux à la fois).
 */
import type { Server } from 'node:http'
import type { APIRequestContext } from '@playwright/test'
import { createMockGithub } from '../scripts/mock-github'
import { expect, test } from './fixtures'

const API = 'http://host.docker.internal:18300'
const SLUG = 'e2e-parallele'
const files: Record<string, string> = { 'compose.yml': 'services:\n' + ['a', 'b', 'c'].map(s => `  ${s}:\n    build:\n      context: .\n      dockerfile: Dockerfile.${s}\n`).join('') }
for (const s of ['a', 'b', 'c']) files[`Dockerfile.${s}`] = `FROM python:3.12-slim\nRUN sleep 6 && echo ${s} > /service\nCMD ["sleep", "3600"]\n`
let server: Server

test.skip(!!process.env.E2E_BASE_URL && !process.env.E2E_GITHUB_MOCK, 'Faux GitHub joignable uniquement depuis la stack de développement')
test.beforeAll(async () => {
  server = createMockGithub({ 'acme/parallele': { files } })
  await new Promise<void>(r => server.listen(18300, '0.0.0.0', r))
})
test.afterAll(() => server?.close())

async function api<T>(request: APIRequestContext, method: 'get' | 'post' | 'put', url: string, data?: unknown): Promise<T> {
  const { csrfToken } = await (await request.get('/api/auth/me')).json() as { csrfToken: string }
  const res = await request[method](url, { data, headers: { 'x-csrf-token': csrfToken } })
  expect(res.status(), await res.text()).toBeLessThan(300)
  return res.json() as Promise<T>
}

test('trois builds : deux à la fois ; analyses avant déploiement avec blocage', async ({ request }) => {
  test.setTimeout(900_000)
  const previous = await api<{ settings: Record<string, unknown> }>(request, 'get', '/api/admin/trivy')
  const existing = (await (await request.get(`/api/projects?q=${SLUG}&archived=all`)).json() as { items: { id: string, slug: string, archivedAt: string | null }[] }).items.find(p => p.slug === SLUG)
  if (existing?.archivedAt) await api(request, 'post', `/api/projects/${existing.id}/archive`, { archived: false })
  const p = existing ?? await api<{ id: string }>(request, 'post', '/api/projects', { slug: SLUG, name: 'E2E parallèle' })
  const opts = await (await request.get('/api/deploy-options')).json() as { endpointId: string, environments: { key: string }[] }[]
  const o = opts.find(x => x.environments.some(e => e.key === 'staging'))!
  let detail = await (await request.get(`/api/projects/${p.id}`)).json() as { targets: { id: string }[] }
  if (!detail.targets.length) await api(request, 'post', `/api/projects/${p.id}/targets`, { endpointId: o.endpointId, environmentKey: 'staging' })
  detail = await (await request.get(`/api/projects/${p.id}`)).json() as typeof detail
  const tid = detail.targets[0]!.id
  await api(request, 'put', `/api/targets/${tid}/auto-rebuild`, { enabled: false, cleanBuild: false })
  await api(request, 'put', `/api/projects/${p.id}/source`, { kind: 'github', apiUrl: API, repository: 'acme/parallele', composePath: 'compose.yml', refType: 'branch', ref: 'main' })
  try {
    // Blocage actif : les analyses restent avant le déploiement (le résultat importe peu ici).
    await api(request, 'put', '/api/admin/trivy', { ...previous.settings, buildScan: true, registryScan: false, sourceScan: false, buildBlock: 'CRITICAL', buildBlockFixableOnly: true })
    const d = await api<{ deploymentId: string }>(request, 'post', `/api/targets/${tid}/deployments`, { source: 'github', refType: 'branch', ref: 'main', portApprovals: [] })
    await expect.poll(async () => ((await (await request.get(`/api/deployments/${d.deploymentId}`)).json()) as { status: string }).status, { timeout: 600_000 }).toMatch(/HEALTHY|FAILED|DEGRADED/)
    const log = await (await request.get(`/api/deployments/${d.deploymentId}/logs?format=text`)).text()
    expect(log).toContain('3 images à construire, 2 à la fois')
    expect(log).toMatch(/Construction des images terminée en/)
    // Deux builds démarrés avant la fin du premier.
    const starts = [...log.matchAll(/Contexte de build :/g)].map(m => m.index!)
    const firstDone = log.indexOf('Image construite en')
    expect(starts.length).toBe(3)
    expect(starts[1]!).toBeLessThan(firstDone)
    expect(starts[2]!).toBeGreaterThan(firstDone)
    // Trois analyses, la dernière ligne résume le temps total.
    expect(log).toContain('Analyse Trivy de 3 image(s) construite(s)')
    expect(log).toMatch(/Analyses Trivy terminées en/)
    expect([...log.matchAll(/ Trivy( \(|\s|:)/g)].length).toBeGreaterThanOrEqual(3)
    // Durées par étape sur la page du déploiement.
    const dep = await api<{ statusDurations: Record<string, number> }>(request, 'get', `/api/deployments/${d.deploymentId}`)
    expect(dep.statusDurations.BUILDING).toBeGreaterThan(5)
  }
  finally {
    await api(request, 'put', '/api/admin/trivy', previous.settings).catch(() => {})
    const t = ((await (await request.get(`/api/projects/${p.id}`)).json()) as { targets: { id: string, currentRelease: unknown }[] }).targets[0]
    if (t?.currentRelease) await api(request, 'post', `/api/targets/${t.id}/actions`, { action: 'delete' }).catch(() => null)
    await api(request, 'post', `/api/projects/${p.id}/archive`, { archived: true }).catch(() => {})
  }
})
