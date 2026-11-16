/** Hôtes joints en SSH (sans agent ni Runner) : assistant et fiche serveur. Hôte de dev : service ssh-host. */
import { expect, test } from './fixtures'

test('assistant : connexion SSH, lecture puis confirmation de l\'empreinte de la clé d\'hôte (rien n\'est enregistré)', async ({ page, request }) => {
  const scan = await request.post('/api/servers/ssh-host-key', { data: { host: 'ssh-host', port: 22 } })
  test.skip(!scan.ok(), 'hôte SSH de dev absent')
  await page.goto('/servers/new')
  await page.locator('#w-name').fill('essai-ssh-e2e')
  await page.getByRole('button', { name: 'Suivant' }).click()
  await page.getByRole('radio', { name: 'SSH' }).click()
  await page.locator('#w-ssh-host').fill('ssh-host')
  await page.locator('#w-ssh-user').fill('deploy')
  await page.getByRole('button', { name: 'Lire la clé d\'hôte' }).click()
  await expect(page.getByText(/^SHA256:/)).toBeVisible()
  await page.getByRole('button', { name: 'Je confirme cette empreinte' }).click()
  await expect(page.getByText('Empreinte confirmée')).toBeVisible()
})

test('fiche d\'un serveur SSH : connexion, clé d\'hôte vérifiée, fichiers et build sans Runner', async ({ page, request }) => {
  const servers = await (await request.get('/api/servers?pageSize=100')).json() as { items: { id: string, transport: string }[] }
  const ssh = servers.items.find(s => s.transport === 'ssh')
  test.skip(!ssh, 'aucun serveur SSH')
  await page.goto(`/servers/${ssh!.id}`)
  await expect(page.getByText('(sans agent ni Runner)')).toBeVisible()
  await page.getByRole('button', { name: 'Vérifier' }).click()
  await expect(page.getByText('L\'hôte présente la clé confirmée')).toBeVisible({ timeout: 15_000 })
  await page.getByRole('tab', { name: 'Runner' }).click()
  await expect(page.getByRole('heading', { name: 'Fichiers et build par SSH' })).toBeVisible()
})

test('assistant : localhost refusé (conteneur de la console), hôte de la console proposé en SSH et pour l\'agent', async ({ page }) => {
  await page.goto('/servers/new')
  await page.locator('#w-name').fill('essai-hote-console-e2e')
  await page.getByRole('button', { name: 'Suivant' }).click()
  // Agent : URL en localhost signalée, corrigée en un clic.
  await page.getByRole('radio', { name: 'Agent Portainer' }).click()
  await page.locator('#w-url').fill('https://localhost:9001')
  await expect(page.getByText(/localhost désigne le conteneur de la console/).first()).toBeVisible()
  await page.getByRole('button', { name: 'Utiliser host.docker.internal' }).click()
  await expect(page.locator('#w-url')).toHaveValue('https://host.docker.internal:9001')
  // SSH : même contrôle, puis choix « Hôte de la console ».
  await page.getByRole('radio', { name: 'SSH' }).click()
  await page.locator('#w-ssh-host').fill('127.0.0.1')
  await expect(page.getByText(/localhost désigne le conteneur de la console/).first()).toBeVisible()
  await page.getByRole('button', { name: 'Utiliser host.docker.internal' }).click()
  await expect(page.locator('#w-ssh-host')).toHaveValue('host.docker.internal')
  await expect(page.getByRole('radio', { name: 'Hôte de la console' })).toHaveAttribute('aria-checked', 'true')
  await expect(page.locator('#w-ssh-host')).toHaveAttribute('readonly', '')
  await page.getByRole('radio', { name: 'Autre hôte' }).click()
  await expect(page.locator('#w-ssh-host')).toHaveValue('')
})
