/**
 * Reconstruction sur la dernière version de la source (faux GitHub de la stack de dev) :
 * - branche suivie : un nouveau commit est détecté puis reconstruit depuis l'écran du projet ;
 * - tag suivi : la dernière release publiée est reconstruite et le tag suivi avance.
 */
import { execFileSync } from 'node:child_process'
import type { Server } from 'node:http'
import type { APIRequestContext } from '@playwright/test'
import { type MockRepo, commitOf, createMockGithub, filesFromDir } from '../scripts/mock-github'
import { expect, test } from './fixtures'

const API = 'http://host.docker.internal:18300'
const SLUG = 'e2e-rebuild'
const base = filesFromDir('e2e/fixtures/gh-app')
// Dépendance vulnérable connue déclarée dans le dépôt (analyse Trivy du code source).
const version = (v: string) => ({ ...base, 'requirements.txt': 'requests==2.19.0\n', 'Dockerfile': base.Dockerfile!.replace('echo "source github"', `echo "${v}"`) })
const repo: MockRepo & { releases: NonNullable<MockRepo['releases']> } = { files: version('version 1'), releases: [] }
let server: Server

test.skip(!!process.env.E2E_BASE_URL && !process.env.E2E_GITHUB_MOCK, 'Faux GitHub joignable uniquement depuis la stack de développement')

test.beforeAll(async () => {
  server = createMockGithub({ 'acme/rebuild': repo })
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
const served = (stack: string) => {
  try {
    return execFileSync('docker', ['exec', `${stack}-web-1`, 'cat', '/www/index.html'], { encoding: 'utf8' }).trim()
  }
  catch {
    return ''
  }
}

test('reconstruire sur le dernier commit de la branche, puis sur la dernière release', async ({ page, request }) => {
  test.setTimeout(900_000)
  type Plan = { mode: string, upToDate: boolean, latest: { ref: string, label: string } | null, current: { label: string } | null }
  const existing = (await (await request.get(`/api/projects?q=${SLUG}&archived=all`)).json() as { items: { id: string, slug: string, archivedAt: string | null }[] }).items.find(p => p.slug === SLUG)
  if (existing?.archivedAt) await api(request, 'post', `/api/projects/${existing.id}/archive`, { archived: false })
  const p = existing ?? await api<{ id: string }>(request, 'post', '/api/projects', { slug: SLUG, name: 'E2E reconstruction' })
  const opts = await (await request.get('/api/deploy-options')).json() as { endpointId: string, environments: { key: string }[] }[]
  const o = opts.find(x => x.environments.some(e => e.key === 'staging'))!
  let detail = await (await request.get(`/api/projects/${p.id}`)).json() as { targets: { id: string, stackName: string | null }[] }
  if (!detail.targets.length) await api(request, 'post', `/api/projects/${p.id}/targets`, { endpointId: o.endpointId, environmentKey: 'staging' })
  detail = await (await request.get(`/api/projects/${p.id}`)).json() as typeof detail
  const tid = detail.targets[0]!.id
  // Reconstruction automatique d'un passage précédent coupée : le worker ne doit pas devancer le test.
  await api(request, 'put', `/api/targets/${tid}/auto-rebuild`, { enabled: false, cleanBuild: false })
  const source = { kind: 'github', apiUrl: API, repository: 'acme/rebuild', composePath: 'compose.yml' }
  await api(request, 'put', `/api/projects/${p.id}/source`, { ...source, refType: 'branch', ref: 'main' })
  try {
    // Premier déploiement : branche main.
    const first = await api<{ deploymentId: string }>(request, 'post', `/api/targets/${tid}/deployments`, { source: 'github', refType: 'branch', ref: 'main', portApprovals: [] })
    await expect.poll(() => status(request, first.deploymentId), { timeout: 300_000 }).toMatch(/HEALTHY|FAILED|DEGRADED/)
    expect(await status(request, first.deploymentId)).toBe('HEALTHY')
    const stack = ((await (await request.get(`/api/projects/${p.id}`)).json()) as { targets: { stackName: string }[] }).targets[0]!.stackName
    expect(served(stack)).toBe('version 1')
    expect(await api<Plan>(request, 'get', `/api/targets/${tid}/rebuild`)).toMatchObject({ mode: 'github-branch', upToDate: true })

    // Nouveau commit sur main : détecté, reconstruit depuis l'écran du projet.
    repo.files = version('version 2')
    const plan = await api<Plan>(request, 'get', `/api/targets/${tid}/rebuild`)
    expect(plan).toMatchObject({ mode: 'github-branch', upToDate: false, latest: { ref: commitOf(repo) } })
    await page.goto(`/projects/${p.id}`)
    await page.getByRole('button', { name: 'Reconstruire', exact: true }).click()
    const dialog = page.getByRole('dialog')
    await expect(dialog.getByText('Nouvelle version disponible')).toBeVisible({ timeout: 30_000 })
    await expect(dialog).toContainText(commitOf(repo).slice(0, 7))
    await dialog.getByRole('button', { name: 'Reconstruire et déployer' }).click()
    await page.waitForURL(/\/deployments\//, { timeout: 60_000 })
    await expect(page.getByRole('log')).toContainText(/Statut : (HEALTHY|FAILED|DEGRADED)/, { timeout: 300_000 })
    await expect(page.getByRole('log')).toContainText('Statut : HEALTHY')
    // Sans blocage (réglage par défaut), les analyses Trivy ne retardent pas le déploiement : lancées en arrière-plan, résultats dans la page Vulnérabilités.
    await expect(page.getByRole('log')).toContainText('Analyses Trivy après le déploiement (blocage désactivé) : 1 image(s) et le code source')
    type Vuln = { source: { manifests: string[], status: string, counts: Record<string, number>, findings: { pkg: string, fixed: string | null }[] } | null }
    await expect.poll(async () => (await api<Vuln>(request, 'get', `/api/targets/${tid}/vulnerabilities`)).source?.status, { timeout: 240_000 }).toBe('ok')
    const vuln = await api<Vuln>(request, 'get', `/api/targets/${tid}/vulnerabilities`)
    expect(vuln.source).toMatchObject({ status: 'ok', manifests: ['requirements.txt'] })
    expect(vuln.source!.findings.some(f => f.pkg === 'requests' && f.fixed)).toBe(true)
    expect(served(stack)).toBe('version 2')
    expect(await api<Plan>(request, 'get', `/api/targets/${tid}/rebuild`)).toMatchObject({ upToDate: true })

    // Tag suivi : la dernière release publiée (hors préversion) est reconstruite, le tag suivi avance.
    repo.releases.push(
      { tag: 'v2.0.0-rc.1', prerelease: true, files: version('version rc') },
      { tag: 'v1.1.0', files: version('version 3') },
      { tag: 'v1.0.0', files: version('version 2') },
    )
    await api(request, 'put', `/api/projects/${p.id}/source`, { ...source, refType: 'tag', ref: 'v1.0.0' })
    expect(await api<Plan>(request, 'get', `/api/targets/${tid}/rebuild`)).toMatchObject({ mode: 'github-release', upToDate: false, current: { label: 'v1.0.0' }, latest: { ref: 'v1.1.0' } })
    const r = await api<{ deploymentId: string }>(request, 'post', `/api/targets/${tid}/rebuild`, { cleanBuild: true })
    await expect.poll(() => status(request, r.deploymentId), { timeout: 300_000 }).toMatch(/HEALTHY|FAILED|DEGRADED/)
    expect(await status(request, r.deploymentId)).toBe('HEALTHY')
    expect(served(stack)).toBe('version 3')
    expect(((await (await request.get(`/api/projects/${p.id}/source`)).json()) as { ref: string }).ref).toBe('v1.1.0')
    expect(await api<Plan>(request, 'get', `/api/targets/${tid}/rebuild`)).toMatchObject({ mode: 'github-release', upToDate: true })

    // Reconstruction automatique : nouvelle release publiée → reconstruite sans intervention.
    type Auto = { enabled: boolean, last: { ref: string, outcome: string, deploymentId: string | null } | null }
    expect(await api<Auto>(request, 'put', `/api/targets/${tid}/auto-rebuild`, { enabled: true, cleanBuild: false })).toMatchObject({ enabled: true })
    expect(await api<{ outcome: string }>(request, 'post', `/api/targets/${tid}/auto-rebuild/check`)).toMatchObject({ outcome: 'up-to-date' })
    // Le worker vérifie aussi chaque minute : la version est traitée une seule fois, par l'un ou l'autre.
    const lastOf = async () => ((await api<{ auto: Auto | null }>(request, 'get', `/api/targets/${tid}/rebuild`)).auto?.last ?? null)
    repo.releases.unshift({ tag: 'v1.2.0', files: version('version 4') })
    await api(request, 'post', `/api/targets/${tid}/auto-rebuild/check`)
    await expect.poll(async () => (await lastOf())?.ref, { timeout: 120_000 }).toBe('v1.2.0')
    const started = (await lastOf())!
    expect(started.outcome).toBe('started')
    await expect.poll(() => status(request, started.deploymentId!), { timeout: 300_000 }).toMatch(/HEALTHY|FAILED|DEGRADED/)
    expect(await status(request, started.deploymentId!)).toBe('HEALTHY')
    expect(served(stack)).toBe('version 4')
    // Une release qui demande un nouveau port : refusée une fois, pas retentée.
    repo.releases.unshift({ tag: 'v1.3.0', files: { ...version('version 5'), 'compose.yml': 'services:\n  web:\n    build: .\n    ports:\n      - "18987:8000"\n' } })
    await api(request, 'post', `/api/targets/${tid}/auto-rebuild/check`)
    await expect.poll(async () => (await lastOf())?.ref, { timeout: 120_000 }).toBe('v1.3.0')
    expect((await lastOf())!.outcome).toBe('refused')
    expect(await api<{ outcome: string }>(request, 'post', `/api/targets/${tid}/auto-rebuild/check`)).toMatchObject({ outcome: 'up-to-date' })
    await page.goto(`/projects/${p.id}`)
    await expect(page.getByRole('button', { name: /Reconstruire\s*auto/ })).toBeVisible()
  }
  finally {
    await api(request, 'put', `/api/targets/${tid}/auto-rebuild`, { enabled: false, cleanBuild: false }).catch(() => {})
    const t = ((await (await request.get(`/api/projects/${p.id}`)).json()) as { targets: { id: string, currentRelease: unknown }[] }).targets[0]
    if (t?.currentRelease) {
      const del = await api<{ deploymentId: string }>(request, 'post', `/api/targets/${t.id}/actions`, { action: 'delete' }).catch(() => null)
      if (del) await expect.poll(() => status(request, del.deploymentId), { timeout: 120_000 }).toBe('DELETED').catch(() => {})
    }
    await api(request, 'post', `/api/projects/${p.id}/archive`, { archived: true }).catch(() => {})
  }
})
