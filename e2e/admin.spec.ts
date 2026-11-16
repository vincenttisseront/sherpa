import { expect, test } from './fixtures'

const inboxUp = async () => fetch('http://localhost:18500/').then(r => r.ok, () => false)

test('notifications : création d\'un canal Teams, envoi de test, suppression', async ({ page }) => {
  test.skip(!await inboxUp(), 'Boîte de développement absente (npm run dev:inbox)')
  await page.goto('/admin/notifications')
  await page.getByRole('button', { name: 'Ajouter un canal' }).click()
  const dialog = page.getByRole('dialog')
  const name = `E2E Teams ${Date.now()}`
  await dialog.getByLabel('Nom').fill(name)
  await dialog.getByLabel('URL du webhook Teams').fill('http://host.docker.internal:18500/teams')
  await dialog.getByRole('button', { name: 'Enregistrer' }).click()
  await expect(page.getByText('Canal enregistré')).toBeVisible()

  const row = page.getByRole('row', { name: new RegExp(name) })
  await row.getByRole('button', { name: 'Tester' }).click()
  await expect(page.getByText(`Message de test envoyé sur « ${name} »`)).toBeVisible()
  const inbox = await (await fetch('http://localhost:18500/')).json() as { summary: string }[]
  expect(inbox[0]!.summary).toBe('Notification de test')

  await row.getByRole('button', { name: 'Supprimer' }).click()
  await page.getByRole('dialog').getByRole('button', { name: 'Supprimer' }).click()
  await expect(page.getByRole('row', { name: new RegExp(name) })).toHaveCount(0)
})

test('notifications : un webhook hors liste est refusé avec un message par champ', async ({ page }) => {
  await page.goto('/admin/notifications')
  await page.getByRole('button', { name: 'Ajouter un canal' }).click()
  const dialog = page.getByRole('dialog')
  await dialog.getByLabel('Nom').fill('Refusé')
  await dialog.getByLabel('URL du webhook Teams').fill('https://exemple.invalid/hook')
  await dialog.getByRole('button', { name: 'Enregistrer' }).click()
  await expect(dialog.getByText(/Hôte non autorisé/)).toBeVisible()
  await dialog.getByRole('button', { name: 'Annuler' }).click()
})

test('rétention : volumes et dernière purge affichés', async ({ page }) => {
  await page.goto('/admin/retention')
  await expect(page.getByRole('heading', { name: 'Rétention des données' })).toBeVisible()
  await expect(page.getByRole('cell', { name: 'Journal d\'audit' })).toBeVisible()
})

test('mise en service : chaque section vérifiée, liens vers les écrans', async ({ page }) => {
  await page.goto('/admin/readiness')
  for (const title of ['Accès et sécurité', 'Comptes et SSO', 'Notifications', 'Serveurs cibles', 'Sources GitHub', 'Exploitation']) {
    await expect(page.getByRole('heading', { name: title })).toBeVisible()
  }
  await expect(page.getByText('Worker actif')).toBeVisible()
  await page.getByRole('switch', { name: 'À faire seulement' }).check()
  await expect(page.locator('li.ok')).toHaveCount(0)
})
