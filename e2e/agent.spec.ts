import { readFileSync } from 'node:fs'
import { expect, test } from './fixtures'

test('assistant : hôte joint par son agent Portainer (secret, commande d\'installation, test réel), sans création', async ({ page }) => {
  await page.goto('/servers/new')
  await page.getByLabel('Nom').fill('agent-e2e')
  await page.getByRole('button', { name: 'Suivant' }).click()
  await page.getByRole('radio', { name: 'Agent Portainer' }).click()

  // Secret généré et repris dans la commande d'installation.
  await page.getByRole('button', { name: 'Générer' }).click()
  const generated = await page.getByLabel('AGENT_SECRET').inputValue()
  expect(generated).toMatch(/^[0-9a-f]{64}$/)
  await expect(page.locator('.install pre')).toContainText(`AGENT_SECRET=${generated}`)
  await expect(page.locator('.install pre')).toContainText('portainer/agent:')

  // Connexion au vrai agent de la stack de dev avec son secret.
  const secret = readFileSync('.data/dev-auth/agent.env', 'utf8').trim().replace(/^AGENT_SECRET=/, '')
  await page.getByLabel('Adresse de l\'agent').fill('https://agent:9001')
  await page.getByLabel('AGENT_SECRET').fill(secret)
  await expect(page.getByText(/certificat auto-signé/)).toBeVisible()
  await page.getByRole('button', { name: 'Suivant' }).click()
  await expect(page.getByText(/Connexion : réussie/)).toBeVisible({ timeout: 20_000 })
  await expect(page.getByText(/Version de l'agent : 2\./)).toBeVisible()
})
