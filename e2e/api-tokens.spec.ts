/**
 * Jetons d'API : création depuis « Mon compte » (valeur affichée une fois), utilisation sans session ni CSRF,
 * portée limitée à un projet, impossibilité de gérer le compte avec un jeton, CLI sherpa, révocation immédiate.
 */
import { execFileSync } from 'node:child_process'
import { type APIRequestContext, request as pwRequest } from '@playwright/test'
import { expect, test } from './fixtures'

async function api<T>(request: APIRequestContext, method: 'get' | 'post' | 'put' | 'delete', url: string, data?: unknown): Promise<T> {
  const { csrfToken } = await (await request.get('/api/auth/me')).json() as { csrfToken: string }
  const res = await request[method](url, { data, headers: { 'x-csrf-token': csrfToken } })
  expect(res.status(), await res.text()).toBeLessThan(300)
  return res.json() as Promise<T>
}

test('jetons d\'API : création, portée, CLI, révocation', async ({ page, request }) => {
  test.setTimeout(300_000)
  const stamp = Date.now().toString(36)
  const opts = await (await request.get('/api/deploy-options')).json() as { endpointId: string, environments: { key: string }[] }[]
  const o = opts.find(x => x.environments.some(e => e.key === 'staging'))!
  const mk = async (slug: string) => {
    const r = await api<{ id: string }>(request, 'post', '/api/projects', { slug, name: `Jeton ${slug}`, target: { endpointId: o.endpointId, environmentKey: 'staging' } })
    const t = ((await (await request.get(`/api/projects/${r.id}`)).json()) as { targets: { id: string }[] }).targets[0]!.id
    return { id: r.id, slug, name: `Jeton ${slug}`, targetId: t }
  }
  const a = await mk(`tk-a-${stamp}`)
  const b = await mk(`tk-b-${stamp}`)
  const base = process.env.E2E_BASE_URL ?? 'http://localhost:3100'
  try {
    // Création depuis l'interface : valeur affichée une seule fois.
    await page.goto('/account')
    await page.getByRole('button', { name: 'Nouveau jeton' }).click({ timeout: 30_000 })
    await page.getByLabel('Nom', { exact: true }).fill('e2e-ci')
    await page.getByLabel('Projet').selectOption({ label: a.name })
    await page.getByRole('button', { name: 'Créer le jeton' }).click()
    const token = (await page.getByTestId('api-token').textContent({ timeout: 30_000 }))!
    expect(token).toMatch(/^shp_[A-Za-z0-9_-]{43}$/)
    await page.getByRole('button', { name: 'J\'ai noté le jeton' }).click()
    await expect(page.getByTestId('api-token')).toHaveCount(0)
    await page.reload()
    await expect(page.getByRole('row', { name: /e2e-ci.*Déploiement \(CI\).*actif/ })).toBeVisible({ timeout: 30_000 })
    await expect(page.getByText(token)).toHaveCount(0)

    // Utilisation sans cookie ni CSRF : au nom du propriétaire, avec moins de droits.
    const bearer = await pwRequest.newContext({ baseURL: base, extraHTTPHeaders: { authorization: `Bearer ${token}` } })
    const me = await (await bearer.get('/api/auth/me')).json() as { authenticated: boolean, user: { email: string }, permissions: string[] }
    expect(me.authenticated).toBe(true)
    expect(me.user.email).toContain('(jeton e2e-ci)')
    expect(me.permissions).toContain('deployment:execute')
    expect(me.permissions).not.toContain('user:manage')
    expect(me.permissions).not.toContain('policy:manage')
    expect((await bearer.get(`/api/projects/${a.id}`)).status()).toBe(200)
    // Écriture sur son projet : acceptée sans jeton CSRF ; sur un autre projet : refusée.
    expect((await bearer.put(`/api/targets/${a.targetId}/auto-rebuild`, { data: { enabled: false, cleanBuild: false } })).status()).toBe(200)
    expect((await bearer.put(`/api/targets/${b.targetId}/auto-rebuild`, { data: { enabled: false, cleanBuild: false } })).status()).toBe(403)
    expect([403, 404]).toContain((await bearer.get(`/api/projects/${b.id}`)).status())
    const list = await (await bearer.get('/api/projects?pageSize=100')).json() as { items: { id: string }[] }
    expect(list.items.some(p => p.id === a.id)).toBe(true)
    expect(list.items.some(p => p.id === b.id)).toBe(false)

    // Jamais pour gérer le compte ou ses jetons, ni pour l'administration.
    expect((await bearer.get('/api/account/tokens')).status()).toBe(403)
    expect((await bearer.post('/api/account/tokens', { data: { name: 'pirate', preset: 'read', expiresInDays: 30 } })).status()).toBe(403)
    expect((await bearer.post('/api/auth/login', { data: { email: 'x@y.z', password: 'x' } })).status()).toBe(403)
    expect((await bearer.get('/api/admin/users')).status()).toBe(403)
    // Mauvais jeton.
    const wrong = await pwRequest.newContext({ baseURL: base, extraHTTPHeaders: { authorization: `Bearer shp_${'x'.repeat(43)}` } })
    expect((await wrong.get('/api/projects')).status()).toBe(401)

    // CLI contre la vraie console.
    const sherpa = (...args: string[]) => {
      try {
        return { code: 0, out: execFileSync('node', ['public/cli/sherpa.mjs', ...args], { env: { PATH: process.env.PATH, SHERPA_URL: base, SHERPA_TOKEN: token }, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }) }
      }
      catch (e) {
        const x = e as { status: number, stdout: string, stderr: string }
        return { code: x.status, out: `${x.stdout}${x.stderr}` }
      }
    }
    expect(sherpa('whoami').out).toContain('(jeton e2e-ci)')
    expect(sherpa('projects').out).toContain(a.slug)
    expect(sherpa('projects').out).not.toContain(b.slug)
    expect(sherpa('status', a.slug).out).toMatch(/staging\s+—/)
    const dep = sherpa('deploy', a.slug, '--env', 'staging')
    expect(dep.code).toBe(1)
    expect(dep.out).toMatch(/Aucune release active|Erreur 409/)
    expect(sherpa('status', b.slug).out).toContain('introuvable')

    // Révocation : immédiate.
    await page.getByRole('button', { name: 'Révoquer e2e-ci' }).click()
    await page.getByRole('dialog').getByRole('button', { name: 'Révoquer' }).click()
    await expect(page.getByRole('row', { name: /e2e-ci.*révoqué/ })).toBeVisible({ timeout: 30_000 })
    expect((await bearer.get('/api/projects')).status()).toBe(401)
    expect(sherpa('whoami').code).toBe(1)
    await bearer.dispose()
    await wrong.dispose()
  }
  finally {
    for (const p of [a, b]) await api(request, 'post', `/api/projects/${p.id}/removal`, { mode: 'delete', confirm: p.slug }).catch(() => null)
  }
})
