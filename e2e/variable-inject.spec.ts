/**
 * Variable injectée depuis l'interface dans l'environnement d'un service que le Compose ne la cite
 * pas (ex. CSRF_TRUSTED_ORIGINS de NetBox), puis appliquée par « Redéployer ».
 */
import { execFileSync } from 'node:child_process'
import { expect, test } from './fixtures'

test('variable injectée dans un service depuis l\'onglet Variables, appliquée au redéploiement', async ({ page, request }) => {
  test.setTimeout(600_000)
  const { csrfToken } = await (await request.get('/api/auth/me')).json() as { csrfToken: string }
  const headers = { 'x-csrf-token': csrfToken }
  const servers = await (await request.get('/api/servers?pageSize=100')).json() as { items: { id: string, name: string }[] }
  const server = servers.items.find(s => s.name === 'agent-local')
  test.skip(!server, 'serveur agent-local absent')
  const detail = await (await request.get(`/api/servers/${server!.id}`)).json() as { endpoints: { id: string, enabled: boolean, environments: { key: string }[] }[] }
  const ep = detail.endpoints.find(e => e.enabled && e.environments.length)!
  const env = ep.environments[0]!.key
  const slug = `inj-${Date.now().toString(36)}`
  const { id } = await (await request.post('/api/projects', { data: { slug, name: `Injection ${slug}`, target: { endpointId: ep.id, environmentKey: env } }, headers })).json() as { id: string }
  try {
    await page.goto(`/projects/${id}`)
    await expect(async () => {
      await page.getByRole('button', { name: 'Nouveau déploiement' }).click({ timeout: 5000 })
      await expect(page.getByRole('textbox', { name: 'Contenu du fichier Compose' })).toBeVisible({ timeout: 3000 })
    }).toPass({ timeout: 30_000 })
    await page.getByRole('textbox', { name: 'Contenu du fichier Compose' }).fill('services:\n  app:\n    image: busybox:1.37\n    command: ["sleep", "3600"]\n  side:\n    image: busybox:1.37\n    command: ["sleep", "3600"]\n')
    await page.getByRole('button', { name: 'Analyser ce Compose' }).click({ timeout: 10_000 })
    await expect(page.getByRole('heading', { name: /Analyse/ })).toBeVisible({ timeout: 60_000 })
    await page.getByRole('button', { name: 'Déployer', exact: true }).click({ timeout: 30_000 })
    await page.getByRole('dialog').getByRole('button', { name: 'Déployer' }).click({ timeout: 10_000 })
    await expect(page.getByRole('log')).toContainText('Statut : HEALTHY', { timeout: 300_000 })

    // Onglet Variables : nouvelle variable, injectée dans « app » seulement.
    await page.goto(`/projects/${id}`)
    await page.getByRole('tab', { name: 'Variables' }).click()
    await page.getByRole('button', { name: 'Ajouter une variable' }).click()
    const row = page.locator('tbody tr').last()
    await row.getByRole('textbox', { name: 'Nom' }).fill('CSRF_TRUSTED_ORIGINS')
    await row.getByRole('textbox', { name: 'Valeur' }).fill('https://netbox.exemple.fr')
    await row.locator('summary').click()
    await row.getByRole('checkbox', { name: 'app' }).check()
    await expect(row.locator('summary')).toHaveText('app')
    await page.getByRole('button', { name: 'Enregistrer les variables' }).click()
    await expect(page.getByText(/Variables enregistrées/)).toBeVisible()
    const targetId = ((await (await request.get(`/api/projects/${id}`)).json()) as { targets: { id: string }[] }).targets[0]!.id
    const saved = await (await request.get(`/api/targets/${targetId}/variables`)).json() as { name: string, inject: string[] }[]
    expect(saved.find(v => v.name === 'CSRF_TRUSTED_ORIGINS')?.inject).toEqual(['app'])

    // Redéployer : la variable atteint « app », pas « side ».
    await page.getByRole('button', { name: 'Redéployer', exact: true }).first().click()
    await page.getByRole('dialog').getByRole('button', { name: 'Redéployer' }).click()
    await expect(page.getByRole('log')).toContainText('Statut : HEALTHY', { timeout: 300_000 })
    const stack = `${slug}-${env}`
    expect(execFileSync('docker', ['exec', `${stack}-app-1`, 'printenv', 'CSRF_TRUSTED_ORIGINS'], { encoding: 'utf8' }).trim()).toBe('https://netbox.exemple.fr')
    expect(() => execFileSync('docker', ['exec', `${stack}-side-1`, 'printenv', 'CSRF_TRUSTED_ORIGINS'], { stdio: 'pipe' })).toThrow()
  }
  finally {
    await request.post(`/api/projects/${id}/removal`, { data: { mode: 'delete', confirm: slug }, headers }).catch(() => null)
  }
})
