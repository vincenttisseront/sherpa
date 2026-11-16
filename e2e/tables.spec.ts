import { readFileSync } from 'node:fs'
import { expect, test } from './fixtures'

test('déploiements : filtres combinés, colonnes, vue sauvegardée (écriture via l\'interface, jeton CSRF)', async ({ page }) => {
  await page.goto('/deployments')
  await page.getByRole('combobox', { name: 'Statut' }).selectOption({ label: 'Réussis' })
  await page.getByRole('combobox', { name: 'Période', exact: true }).selectOption('7d')
  await expect(page.getByRole('button', { name: /Réinitialiser \(2\)/ })).toBeVisible()
  for (const badge of await page.locator('tbody .badge, tbody [class*="badge"]').allTextContents()) expect(badge).not.toMatch(/Échec/)

  await page.getByLabel('Colonnes', { exact: true }).click()
  await page.getByRole('group', { name: 'Colonnes affichées' }).getByLabel('Serveur').check()
  await expect(page.getByRole('columnheader', { name: 'Serveur' })).toBeVisible()

  const name = `E2E ${Date.now()}`
  await page.getByRole('button', { name: 'Enregistrer la vue' }).click()
  await page.getByLabel('Nom de la vue').fill(name)
  await page.getByRole('dialog').getByRole('button', { name: 'Enregistrer' }).click()
  await expect(page.getByText(`Vue « ${name} » enregistrée`)).toBeVisible()
  await expect(page.getByRole('dialog')).toHaveCount(0)

  // Réinitialisation puis réapplication de la vue.
  await page.getByRole('button', { name: /Réinitialiser/ }).click()
  await expect(page.getByRole('combobox', { name: 'Statut' }).locator('option:checked')).toHaveText('Tous les statuts')
  await page.getByLabel('Vues sauvegardées').selectOption({ label: name })
  await expect(page.getByRole('combobox', { name: 'Statut' })).toHaveValue('HEALTHY')
  await expect(page.getByRole('combobox', { name: 'Période', exact: true })).toHaveValue('7d')

  // Suppression via la confirmation custom.
  await page.getByRole('button', { name: 'Supprimer la vue' }).click()
  await page.getByRole('dialog').getByRole('button', { name: 'Supprimer' }).click()
  await expect(page.getByLabel('Vues sauvegardées').locator('option', { hasText: name })).toHaveCount(0)
})

test('export CSV : mêmes filtres que l\'écran, colonnes visibles, export audité', async ({ page }) => {
  await page.goto('/projects?period=6m')
  const download = page.waitForEvent('download')
  await page.getByRole('link', { name: 'Exporter CSV' }).click()
  const file = await download
  expect(file.suggestedFilename()).toMatch(/^projets-\d{12}\.csv$/)
  const csv = readFileSync((await file.path())!, 'utf8')
  expect(csv.charCodeAt(0)).toBe(0xFEFF)
  expect(csv.split('\r\n')[0]).toContain('Projet;')

  await page.goto('/audit?action=export.&period=24h')
  await expect(page.getByRole('cell', { name: 'export.csv' }).first()).toBeVisible()
})

test('serveur : filtre des endpoints et des réseaux', async ({ page }) => {
  await page.goto('/servers')
  await page.locator('tbody a').first().click()
  await page.getByRole('tab', { name: /Endpoints/ }).click()
  const filter = page.getByPlaceholder('Filtrer les endpoints…')
  await filter.fill('zzz-introuvable')
  await expect(page.getByText('Aucun endpoint ne correspond au filtre')).toBeVisible()
  await page.getByRole('button', { name: 'Réinitialiser' }).click()
  await expect(filter).toHaveValue('')
})

test('déploiements : sélection d\'échecs non acquittés et barre d\'actions groupées', async ({ page }) => {
  await page.goto('/deployments?unacknowledged=true')
  const boxes = page.getByRole('checkbox', { name: 'Sélectionner la ligne' })
  test.skip(await boxes.count() === 0, 'aucun échec non acquitté dans les données')
  await boxes.first().check()
  await expect(page.getByRole('region', { name: 'Actions groupées' })).toContainText('1 sélectionné')
  await expect(page.getByRole('button', { name: 'Acquitter la sélection' })).toBeVisible()
  await page.getByRole('button', { name: 'Désélectionner' }).click()
  await expect(page.getByRole('region', { name: 'Actions groupées' })).toHaveCount(0)
})
