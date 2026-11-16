/**
 * Image que son registre ne sert pas : signalée à l'analyse, AVANT tout déploiement, avec les
 * sources équivalentes vérifiées ; la source choisie est appliquée et le déploiement réussit.
 */
import { execFileSync } from 'node:child_process'
import { expect, test } from './fixtures'

test('image introuvable : autre source proposée à l\'analyse, choisie, puis déployée', async ({ page, request }) => {
  test.setTimeout(600_000)
  const { csrfToken } = await (await request.get('/api/auth/me')).json() as { csrfToken: string }
  const headers = { 'x-csrf-token': csrfToken }
  const servers = await (await request.get('/api/servers?pageSize=100')).json() as { items: { id: string, name: string }[] }
  const server = servers.items.find(s => s.name === 'agent-local')
  test.skip(!server, 'serveur agent-local absent')
  const detail = await (await request.get(`/api/servers/${server!.id}`)).json() as { endpoints: { id: string, enabled: boolean, environments: { key: string }[] }[] }
  const ep = detail.endpoints.find(e => e.enabled && e.environments.length)!
  const env = ep.environments[0]!.key
  const slug = `src-${Date.now().toString(36)}`
  const { id } = await (await request.post('/api/projects', { data: { slug, name: `Source ${slug}`, target: { endpointId: ep.id, environmentKey: env } }, headers })).json() as { id: string }
  try {
    await page.goto(`/projects/${id}`)
    await expect(async () => {
      await page.getByRole('button', { name: 'Nouveau déploiement' }).click({ timeout: 5000 })
      await expect(page.getByRole('textbox', { name: 'Contenu du fichier Compose' })).toBeVisible({ timeout: 3000 })
    }).toPass({ timeout: 30_000 })
    // quay.io ne publie pas traefik/whoami (refusé par le registre) ; Docker Hub et ghcr.io oui.
    await page.getByRole('textbox', { name: 'Contenu du fichier Compose' }).fill('services:\n  web:\n    image: quay.io/traefik/whoami:v1.10\n')
    await page.getByRole('button', { name: 'Analyser ce Compose' }).click({ timeout: 10_000 })
    await expect(page.getByText(/Image quay\.io\/traefik\/whoami:v1\.10 non récupérable/)).toBeVisible({ timeout: 60_000 })
    await page.getByRole('button', { name: 'Utiliser traefik/whoami:v1.10' }).click()
    await expect(page.getByText(/image traefik\/whoami:v1\.10 utilisée/)).toBeVisible()
    await expect(page.getByText(/non récupérable/)).toHaveCount(0, { timeout: 60_000 })

    await page.getByRole('button', { name: 'Déployer', exact: true }).click({ timeout: 30_000 })
    await page.getByRole('dialog').getByRole('button', { name: 'Déployer' }).click({ timeout: 10_000 })
    await expect(page.getByRole('log')).toContainText('Statut : HEALTHY', { timeout: 300_000 })
    expect(execFileSync('docker', ['inspect', '-f', '{{.Config.Image}}', `${slug}-${env}-web-1`], { encoding: 'utf8' }).trim()).toBe('traefik/whoami:v1.10')
  }
  finally {
    await request.post(`/api/projects/${id}/removal`, { data: { mode: 'delete', confirm: slug }, headers }).catch(() => null)
  }
})
