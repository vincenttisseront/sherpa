/**
 * Parcours complet dans le navigateur, sur la vraie infrastructure de dev :
 * archive ZIP → analyse → confirmation → build/déploiement Portainer → logs en direct.
 * Projet « Démo Watchtower » (cible staging) ; images du registre local de dev.
 */
import { makeZip } from '../server/lib/zip-writer'
import { expect, test } from './fixtures'

test('déploiement d\'une archive ZIP depuis l\'interface, jusqu\'aux healthchecks', async ({ page, request }) => {
  test.setTimeout(240_000)
  const projects = await (await request.get('/api/projects?q=wt-demo')).json() as { items: { id: string, slug: string }[] }
  const project = projects.items.find(p => p.slug === 'wt-demo')
  test.skip(!project, 'Projet de démonstration « wt-demo » absent')

  await page.goto(`/projects/${project!.id}`)
  await page.getByRole('button', { name: 'Nouveau déploiement' }).click()
  const zip = makeZip([{ name: 'app/compose.yml', data: 'services:\n  hello:\n    image: localhost:15000/demo/hello:stable\n  watcher:\n    image: localhost:15000/demo/hello:stable\n' }])
  await page.locator('input[type=file]').setInputFiles({ name: 'e2e.zip', mimeType: 'application/zip', buffer: zip })
  await expect(page.getByRole('heading', { name: /Analyse/ })).toBeVisible({ timeout: 30_000 })
  await expect(page.getByText(/platform-watchtower/).first()).toBeVisible()

  await page.getByRole('button', { name: 'Déployer', exact: true }).click()
  await page.getByRole('dialog').getByRole('button', { name: 'Déployer' }).click()
  await expect(page).toHaveURL(/\/deployments\/[0-9a-f-]{36}$/)

  // Logs en direct, puis statut final.
  await expect(page.getByRole('log')).toContainText('Validation conforme', { timeout: 60_000 })
  await expect(page.getByText('Sain', { exact: true }).first()).toBeVisible({ timeout: 180_000 })
  await expect(page.getByRole('log')).toContainText('Statut : HEALTHY')

  // Filtres du visualiseur de logs.
  await page.getByRole('combobox', { name: 'Phase' }).selectOption('healthcheck')
  await expect(page.locator('.line').first()).toContainText('Healthchecks')
})
