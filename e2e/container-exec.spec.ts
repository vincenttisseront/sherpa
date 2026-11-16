/**
 * Terminal dans un conteneur : ouverture depuis le détail d'un conteneur, saisie et sortie réelles (docker exec),
 * fermeture, audit (ouverture, fermeture, refus), droit dédié, interdit aux jetons d'API, session propre à son auteur.
 * Conteneur cible : un conteneur en marche de l'hôte SSH de développement (avec sh).
 */
import { type APIRequestContext, request as pwRequest } from '@playwright/test'
import { expect, test } from './fixtures'
import { api, base, csrf, freshContext, makeUser, resetRateLimits, uiLogin } from './helpers/accounts'

test.beforeEach(() => resetRateLimits())

interface Live { endpointId: string, serverId: string, serverName: string, containers: { id: string, name: string, state: string }[] }

/** Premier conteneur d'un hôte joint en SSH sur lequel un terminal s'ouvre (le proxy de l'agent Portainer ne laisse pas passer le flux). */
async function target(request: APIRequestContext) {
  const servers = await (await request.get('/api/servers?pageSize=100')).json() as { items: { id: string, transport: string }[] }
  const ssh = new Set(servers.items.filter(x => x.transport === 'ssh').map(x => x.id))
  const eps = await (await request.get('/api/live')).json() as Live[]
  for (const ep of eps.filter(e => ssh.has(e.serverId))) {
    for (const c of ep.containers.filter(x => x.state === 'running')) {
      const res = await request.post(`/api/endpoints/${ep.endpointId}/containers/${c.id}/exec`, { data: { cols: 80, rows: 24, shell: 'sh' }, headers: { 'x-csrf-token': await csrf(request) } })
      if (!res.ok()) continue
      await request.delete(`/api/exec/${((await res.json()) as { sessionId: string }).sessionId}`, { headers: { 'x-csrf-token': await csrf(request) } })
      return { ep, c }
    }
  }
  return null
}

async function auditRows(request: APIRequestContext, action: string) {
  const r = await (await request.get(`/api/audit?action=${action}&pageSize=20`)).json() as { items: { actor: string, outcome: string, details: Record<string, unknown> }[] }
  return r.items
}

test('terminal : saisie et sortie réelles, fermeture, audit', async ({ page, request }) => {
  test.setTimeout(120_000)
  const t = await target(request)
  test.skip(!t, 'aucun conteneur ouvrable sur un hôte SSH de développement')
  await page.goto('/containers')
  await page.getByLabel('Rechercher un conteneur').fill(t!.c.name)
  await page.locator('.rows .row').first().click()
  const drawer = page.getByRole('dialog')
  await drawer.getByRole('tab', { name: 'Console' }).click({ timeout: 30_000 })
  await expect(drawer.getByTestId('exec-terminal')).toBeHidden()
  await drawer.getByTestId('exec-open').click()
  const term = drawer.getByTestId('exec-terminal')
  await expect(drawer.getByText('connecté', { exact: true })).toBeVisible({ timeout: 30_000 })
  await term.click()
  await page.keyboard.type('echo $((6*7))-ok')
  await page.keyboard.press('Enter')
  await expect(term).toContainText('42-ok', { timeout: 30_000 })
  await page.keyboard.type('uname -s')
  await page.keyboard.press('Enter')
  await expect(term).toContainText('Linux', { timeout: 30_000 })
  await page.keyboard.type('exit')
  await page.keyboard.press('Enter')
  await expect(drawer.getByTestId('exec-message')).toContainText('Session terminée', { timeout: 30_000 })

  // Audit : ouverture et fermeture, volumes échangés, jamais la saisie.
  const opened = await auditRows(request, 'container.exec_open')
  expect(opened[0]!.outcome).toBe('success')
  expect(opened[0]!.details.container).toBe(t!.c.name)
  const closed = await auditRows(request, 'container.exec_close')
  expect(closed[0]!.details.bytesIn).toBeGreaterThan(10)
  expect(closed[0]!.details.bytesOut).toBeGreaterThan(10)
  expect(JSON.stringify(closed[0])).not.toContain('6*7')
  await page.keyboard.press('Escape')
})

test('terminal : droit dédié, jetons d\'API refusés, session propre à son auteur', async ({ browser, request }) => {
  test.setTimeout(120_000)
  const t = await target(request)
  test.skip(!t, 'aucun conteneur ouvrable sur un hôte SSH de développement')
  const url = `/api/endpoints/${t!.ep.endpointId}/containers/${t!.c.id}/exec`
  const viewer = await makeUser(request, 'viewer', false, 'viewer')
  const ctx = await freshContext(browser)
  const page = await ctx.newPage()
  try {
    await uiLogin(page, viewer.email)
    await page.waitForURL(u => !u.pathname.startsWith('/login'))
    // Lecteur : voit le conteneur mais n'a pas le droit d'ouvrir un terminal (refus journalisé).
    const denied = await ctx.request.post(url, { data: { cols: 80, rows: 24 }, headers: { 'x-csrf-token': await csrf(ctx.request) } })
    expect(denied.status()).toBe(403)
    expect((await auditRows(request, 'container.exec_open')).some(r => r.outcome === 'denied' && r.actor === viewer.email)).toBe(true)

    // Administrateur : ouvre un terminal ; le lecteur ne peut ni le lire ni y écrire.
    const opened = await api<{ sessionId: string }>(request, 'post', url, { cols: 80, rows: 24 })
    expect(opened.sessionId).toBeTruthy()
    expect((await ctx.request.get(`/api/exec/${opened.sessionId}/stream`)).status()).toBe(404)
    expect((await ctx.request.post(`/api/exec/${opened.sessionId}`, { data: { type: 'input', data: 'id\n' }, headers: { 'x-csrf-token': await csrf(ctx.request) } })).status()).toBe(404)

    // Jeton d'API de l'administrateur : jamais de terminal, même avec tous ses droits.
    const created = await api<{ token: string }>(request, 'post', '/api/account/tokens', { name: 'e2e-exec', preset: 'deploy', projectId: null, environmentId: null, expiresInDays: 30 })
    const bearer = await pwRequest.newContext({ baseURL: base, extraHTTPHeaders: { authorization: `Bearer ${created.token}` } })
    expect((await bearer.post(url, { data: { cols: 80, rows: 24 } })).status()).toBe(403)
    await bearer.dispose()

    // Fermeture explicite par son auteur.
    await api(request, 'delete', `/api/exec/${opened.sessionId}`)
    const closed = await auditRows(request, 'container.exec_close')
    expect(closed.some(r => r.details.reason === 'fermé par l\'utilisateur')).toBe(true)
    // Jeton de l'essai révoqué.
    const list = await (await request.get('/api/account/tokens')).json() as { id: string, name: string, status: string }[]
    for (const tk of list.filter(x => x.name === 'e2e-exec' && x.status === 'active')) await api(request, 'delete', `/api/account/tokens/${tk.id}`)
  }
  finally {
    await ctx.close()
    await api(request, 'patch', `/api/admin/users/${viewer.id}`, { status: 'suspended' }).catch(() => undefined)
  }
})

test('terminal : hôte joint par l\'agent Portainer, refus explicite et onglet masqué', async ({ page, request }) => {
  const servers = await (await request.get('/api/servers?pageSize=100')).json() as { items: { id: string, transport: string }[] }
  const agent = new Set(servers.items.filter(x => x.transport === 'agent').map(x => x.id))
  const eps = await (await request.get('/api/live')).json() as Live[]
  const ep = eps.find(e => agent.has(e.serverId) && e.containers.some(c => c.state === 'running'))
  test.skip(!ep, 'aucun hôte agent avec un conteneur en marche')
  const c = ep!.containers.find(x => x.state === 'running')!
  const res = await request.post(`/api/endpoints/${ep!.endpointId}/containers/${c.id}/exec`, { data: { cols: 80, rows: 24 }, headers: { 'x-csrf-token': await csrf(request) } })
  expect(res.status()).toBe(409)
  expect(await res.text()).toContain('SSH')
  const detail = await (await request.get(`/api/endpoints/${ep!.endpointId}/containers/${c.id}`)).json() as { execSupported: boolean }
  expect(detail.execSupported).toBe(false)
  await page.goto('/containers')
  await page.getByLabel('Rechercher un conteneur').fill(c.name)
  await page.locator('.rows .row').first().click()
  await expect(page.getByRole('dialog').getByRole('tab', { name: 'Aperçu' })).toBeVisible({ timeout: 30_000 })
  await expect(page.getByRole('dialog').getByRole('tab', { name: 'Console' })).toHaveCount(0)
})
