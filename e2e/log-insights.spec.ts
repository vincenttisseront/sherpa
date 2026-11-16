/**
 * Analyse des logs : un service qui plante au démarrage sur un fichier d'état libtorrent corrompu
 * (cas de Deluge) ; la cause et quoi faire sont affichés en direct dans les logs du service et
 * sur la page Diagnostic.
 */
import { expect, test } from './fixtures'

test('analyse des logs : fichier d\'état libtorrent corrompu reconnu (logs en direct et diagnostic)', async ({ page, request }) => {
  test.setTimeout(600_000)
  const { csrfToken } = await (await request.get('/api/auth/me')).json() as { csrfToken: string }
  const headers = { 'x-csrf-token': csrfToken }
  const servers = await (await request.get('/api/servers?pageSize=100')).json() as { items: { id: string, name: string }[] }
  const server = servers.items.find(s => s.name === 'agent-local')
  test.skip(!server, 'serveur agent-local absent')
  const detail = await (await request.get(`/api/servers/${server!.id}`)).json() as { endpoints: { id: string, enabled: boolean, environments: { key: string }[] }[] }
  const ep = detail.endpoints.find(e => e.enabled && e.environments.length)!
  const env = ep.environments[0]!.key
  const slug = `log-${Date.now().toString(36)}`
  const { id } = await (await request.post('/api/projects', { data: { slug, name: `Logs ${slug}`, target: { endpointId: ep.id, environmentKey: env } }, headers })).json() as { id: string }
  try {
    await page.goto(`/projects/${id}`)
    await expect(async () => {
      await page.getByRole('button', { name: 'Nouveau déploiement' }).click({ timeout: 5000 })
      await expect(page.getByRole('textbox', { name: 'Contenu du fichier Compose' })).toBeVisible({ timeout: 3000 })
    }).toPass({ timeout: 30_000 })
    await page.getByRole('textbox', { name: 'Contenu du fichier Compose' }).fill('services:\n  app:\n    image: busybox:1.37\n    command: ["sleep", "3600"]\n  torrent:\n    image: busybox:1.37\n    restart: unless-stopped\n    command: ["sh", "-c", "echo \\"terminate called after throwing an instance of \'libtorrent::system_error\'\\"; echo \'  what():  invalid type requested from entry\'; sleep 1; exit 134"]\n')
    await page.getByRole('button', { name: 'Analyser ce Compose' }).click({ timeout: 10_000 })
    await page.getByRole('button', { name: 'Déployer', exact: true }).click({ timeout: 60_000 })
    await page.getByRole('dialog').getByRole('button', { name: 'Déployer' }).click({ timeout: 10_000 })
    await expect(page.getByRole('log')).toContainText(/Statut : (DEGRADED|FAILED|HEALTHY)/, { timeout: 300_000 })

    // Logs en direct du service : cause reconnue et quoi faire.
    await page.goto(`/projects/${id}`)
    await page.getByRole('tab', { name: 'Conteneurs' }).click()
    await page.getByRole('row', { name: /^torrent/ }).getByRole('button', { name: 'Logs' }).click({ timeout: 30_000 })
    await page.getByRole('tab', { name: 'Logs' }).click()
    const insights = page.getByRole('region', { name: 'Analyse des logs' })
    await expect(insights.getByText('Fichier d\'état libtorrent corrompu')).toBeVisible({ timeout: 30_000 })
    await expect(insights.getByText(/torrents\.fastresume/)).toBeVisible()
    await expect(insights.getByText('Exception C++ non gérée')).toHaveCount(0)

    // Page Diagnostic : même constat sur le service.
    const targetId = ((await (await request.get(`/api/projects/${id}`)).json()) as { targets: { id: string }[] }).targets[0]!.id
    await page.goto(`/diagnostic/${targetId}`)
    await expect(page.getByText(/Logs : Fichier d'état libtorrent corrompu/)).toBeVisible({ timeout: 60_000 })
  }
  finally {
    await request.post(`/api/projects/${id}/removal`, { data: { mode: 'delete', confirm: slug }, headers }).catch(() => null)
  }
})
