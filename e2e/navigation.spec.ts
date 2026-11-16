import { expect, test } from './fixtures'

test('tableau de bord : indicateurs, période, liens vers les tableaux filtrés', async ({ page }) => {
  await page.goto('/')
  await expect(page.getByRole('heading', { name: 'Tableau de bord' })).toBeVisible()
  await expect(page.locator('.tile')).toHaveCount(10)
  // Ce qui est déployé, puis ce qui reste à faire.
  await expect(page.getByRole('heading', { name: /^Déployé/ })).toBeVisible()
  await expect(page.getByRole('heading', { name: /En attente/ })).toBeVisible()
  await page.getByLabel('Période des indicateurs').selectOption('30d')
  await page.locator('.tile', { hasText: 'Déploiements échoués' }).click()
  await expect(page).toHaveURL(/\/deployments\?unacknowledged=true/)
  await expect(page.getByRole('combobox', { name: 'Statut' })).toHaveValue('unack')
  await expect(page.getByRole('combobox', { name: 'Période', exact: true })).toHaveValue('30d')
})

test('pages principales accessibles depuis la navigation', async ({ page }) => {
  await page.goto('/')
  for (const [label, heading] of [['Projets', 'Projets'], ['Déploiements', 'Déploiements'], ['Mises à jour d\'images', 'Mises à jour d\'images'], ['Serveurs', 'Serveurs'], ['Audit', 'Audit']] as const) {
    await page.getByRole('navigation', { name: 'Navigation principale' }).getByRole('link', { name: label, exact: true }).click()
    await expect(page.getByRole('heading', { level: 1, name: heading })).toBeVisible()
  }
})

test('en-têtes de sécurité et CSP stricte sur les pages', async ({ page }) => {
  const res = await page.goto('/projects')
  const h = res!.headers()
  expect(h['content-security-policy']).toMatch(/script-src 'self'( 'sha256-[^']+')+;/)
  expect(h['content-security-policy']).toContain('frame-ancestors \'none\'')
  expect(h['x-frame-options']).toBe('DENY')
  expect(h['x-content-type-options']).toBe('nosniff')
})

test('sans session : redirection vers la connexion, API refusée', async ({ browser, baseURL }) => {
  const ctx = await browser.newContext({ storageState: { cookies: [], origins: [] }, baseURL })
  const page = await ctx.newPage()
  await page.goto('/projects')
  await expect(page).toHaveURL(/\/login\?returnTo=(%2F|\/)projects/)
  expect((await page.request.get('/api/projects')).status()).toBe(401)
  expect((await page.request.post('/api/saved-views', { data: {} })).status()).toBe(401)
  await ctx.close()
})

test('déploiement en échec : acquitter puis annuler depuis sa page (via l\'interface, jeton CSRF)', async ({ page, request }) => {
  const list = await (await request.get('/api/deployments?pageSize=100')).json() as { items: { id: string, status: string }[] }
  const failed = list.items.find(d => ['FAILED', 'ROLLED_BACK', 'VALIDATION_FAILED'].includes(d.status))
  test.skip(!failed, 'aucun déploiement en échec dans les données')
  await page.goto(`/deployments/${failed!.id}`)
  const ack = page.getByRole('button', { name: 'Acquitter l\'échec' })
  if (!(await ack.isVisible())) await page.getByRole('button', { name: 'Annuler l\'acquittement' }).click()
  await page.getByRole('button', { name: 'Acquitter l\'échec' }).click()
  await expect(page.getByText(/acquitté par/)).toBeVisible()
  await page.getByRole('button', { name: 'Annuler l\'acquittement' }).click()
  await expect(page.getByRole('button', { name: 'Acquitter l\'échec' })).toBeVisible()
})

test('diagnostic d\'une cible : verdict et services, depuis la fiche projet', async ({ page, request }) => {
  const d = await (await request.get('/api/dashboard?period=7d')).json() as { deployed: { targetId: string, projectId: string }[] }
  test.skip(!d.deployed.length, 'Aucune cible déployée')
  const t = d.deployed[0]!
  await page.goto(`/projects/${t.projectId}`)
  await page.getByRole('button', { name: 'Diagnostic', exact: true }).first().click()
  await expect(page).toHaveURL(/\/diagnostic\//)
  await expect(page.getByRole('heading', { level: 1, name: 'Diagnostic' })).toBeVisible()
  await expect(page.locator('.verdict')).toBeVisible({ timeout: 60_000 })
})

test('projet : onglet Conteneurs (état, actions de la stack et des services, détail)', async ({ page, request }) => {
  const d = await (await request.get('/api/dashboard?period=7d')).json() as { deployed: { projectId: string }[] }
  test.skip(!d.deployed.length, 'Aucune cible déployée')
  await page.goto(`/projects/${d.deployed[0]!.projectId}`)
  await page.getByRole('tab', { name: 'Conteneurs' }).click()
  const table = page.locator('.tc table')
  await expect(table).toBeVisible({ timeout: 60_000 })
  await expect(page.getByText(/\d+ \/ \d+ en marche/)).toBeVisible()
  // Détail d'un conteneur (sans action modifiante).
  await table.getByRole('button', { name: 'Logs' }).first().click()
  await expect(page.getByRole('dialog')).toBeVisible()
  await page.keyboard.press('Escape')
})
