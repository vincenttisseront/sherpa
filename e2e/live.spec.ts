import { expect, test } from './fixtures'

test('conteneurs en direct : flux, moteur, filtres et détail d\'un conteneur', async ({ page }) => {
  await page.goto('/containers')
  await expect(page.getByRole('heading', { level: 1, name: 'Conteneurs en direct' })).toBeVisible()
  await expect(page.locator('.conn.on')).toContainText('En direct', { timeout: 15_000 })
  const engine = page.locator('.pill').first()
  await expect(engine).toContainText('en marche')
  await expect(page.locator('.group').first()).toBeVisible()

  // Filtre « En marche » puis recherche sans résultat.
  await page.getByRole('radio', { name: /En marche/ }).click()
  await expect(page.locator('.rows li').first()).toBeVisible()
  await page.getByLabel('Rechercher un conteneur').fill('zzz-introuvable')
  await expect(page.getByText('Aucun conteneur ne correspond')).toBeVisible()
  await page.getByLabel('Rechercher un conteneur').fill('')

  // Détail : métriques en direct, logs, variables (noms seulement).
  await page.locator('.rows .row').first().click()
  const drawer = page.getByRole('dialog')
  await expect(drawer.getByText('CPU')).toBeVisible({ timeout: 15_000 })
  await drawer.getByRole('tab', { name: 'Logs' }).click()
  await expect(drawer.getByRole('log')).toBeVisible()
  await drawer.getByRole('tab', { name: /Variables/ }).click()
  await expect(drawer.getByText('Valeurs jamais lues.')).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(page.getByRole('dialog')).toHaveCount(0)
})

test('nettoyage Docker : occupation, candidats et protections, rien de présélectionné', async ({ page, request }) => {
  const [ep] = await (await request.get('/api/live')).json() as { serverId: string, endpointId: string }[]
  await page.goto(`/servers/${ep!.serverId}?tab=cleanup&endpoint=${ep!.endpointId}`)
  await expect(page.getByText('Cache de build').first()).toBeVisible({ timeout: 20_000 })
  await expect(page.locator('.usage .u')).toHaveCount(4)
  // Sans choix, le bouton est inactif ; aucun volume ni réseau n'est coché d'office.
  await expect(page.getByRole('button', { name: 'Nettoyer', exact: true })).toBeDisabled()
  await expect(page.locator('.items input[type=checkbox]:checked')).toHaveCount(0)
  await page.getByLabel(/Cache de build/).check()
  await expect(page.getByRole('button', { name: 'Nettoyer', exact: true })).toBeEnabled()
  // Confirmation demandée (annulée ici : aucun nettoyage réel pendant les tests).
  await page.getByRole('button', { name: 'Nettoyer', exact: true }).click()
  await expect(page.getByRole('dialog').getByText(/Suppression définitive/)).toBeVisible()
  await page.getByRole('dialog').getByRole('button', { name: 'Annuler' }).click()
})

test('fiche serveur, onglet Conteneurs : « Reprendre en projet » ouvre l\'onglet Reprise et l\'assistant de la stack', async ({ page, request }) => {
  const servers = await (await request.get('/api/servers?pageSize=100')).json() as { items: { id: string, name: string }[] }
  const s = servers.items.find(x => x.name === 'agent-local')
  test.skip(!s, 'serveur agent-local absent')
  await page.goto(`/servers/${s!.id}?tab=live`)
  const link = page.getByRole('link', { name: /Reprendre en projet/ }).first()
  test.skip(!(await link.waitFor({ timeout: 20_000 }).then(() => true, () => false)), 'aucune stack externe sur agent-local')
  const stack = new URL(await link.getAttribute('href') ?? '', 'http://x').searchParams.get('stack')
  await link.click()
  await expect(page.getByRole('tab', { name: 'Reprise' })).toHaveAttribute('aria-selected', 'true')
  await expect(page.getByText(`Reprendre « ${stack} »`)).toBeVisible()
})
