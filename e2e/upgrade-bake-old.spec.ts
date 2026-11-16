/**
 * Surcharge d'image antérieure au report automatique (ex. mise à niveau faite avec une ancienne
 * version de la console) : écrite dans le Compose du projet au démarrage du worker.
 */
import { execFileSync } from 'node:child_process'
import { expect, test } from './fixtures'

test('ancienne surcharge reportée dans le Compose du projet au démarrage du worker', async ({ page, request }) => {
  test.setTimeout(600_000)
  const { csrfToken } = await (await request.get('/api/auth/me')).json() as { csrfToken: string }
  const headers = { 'x-csrf-token': csrfToken }
  const servers = await (await request.get('/api/servers?pageSize=100')).json() as { items: { id: string, name: string }[] }
  const server = servers.items.find(s => s.name === 'agent-local')
  test.skip(!server, 'serveur agent-local absent')
  const detail = await (await request.get(`/api/servers/${server!.id}`)).json() as { endpoints: { id: string, enabled: boolean, environments: { key: string }[] }[] }
  const ep = detail.endpoints.find(e => e.enabled && e.environments.length)!
  const env = ep.environments[0]!.key
  const slug = `bak-${Date.now().toString(36)}`
  const { id } = await (await request.post('/api/projects', { data: { slug, name: `Report ${slug}`, target: { endpointId: ep.id, environmentKey: env } }, headers })).json() as { id: string }
  try {
    await page.goto(`/projects/${id}`)
    await expect(async () => {
      await page.getByRole('button', { name: 'Nouveau déploiement' }).click({ timeout: 5000 })
      await expect(page.getByRole('textbox', { name: 'Contenu du fichier Compose' })).toBeVisible({ timeout: 3000 })
    }).toPass({ timeout: 30_000 })
    await page.getByRole('textbox', { name: 'Contenu du fichier Compose' }).fill('services:\n  app:\n    image: busybox:1.36\n    command: ["sleep", "3600"]\n')
    await page.getByRole('button', { name: 'Analyser ce Compose' }).click({ timeout: 10_000 })
    await page.getByRole('button', { name: 'Déployer', exact: true }).click({ timeout: 60_000 })
    await page.getByRole('dialog').getByRole('button', { name: 'Déployer' }).click({ timeout: 10_000 })
    await expect(page.getByRole('log')).toContainText('Statut : HEALTHY', { timeout: 300_000 })

    // Surcharge laissée par une ancienne version de la console (mise à niveau sans report).
    const targetId = ((await (await request.get(`/api/projects/${id}`)).json()) as { targets: { id: string }[] }).targets[0]!.id
    const override = JSON.stringify({ images: { app: { image: 'busybox:1.37', from: 'busybox:1.36', at: new Date().toISOString(), by: 'test' } } })
    execFileSync('docker', ['exec', 'sherpa-dev-postgres-1', 'psql', '-U', 'platform', '-d', 'platform', '-c', `update project_targets set compose_overrides = compose_overrides || '${override}'::jsonb where id = '${targetId}'`], { stdio: 'ignore' })
    const overrides = async () => ((await (await request.get(`/api/projects/${id}`)).json()) as { targets: { composeOverrides: { images: Record<string, unknown> } }[] }).targets[0]!.composeOverrides.images
    expect(Object.keys(await overrides())).toEqual(['app'])

    execFileSync('docker', ['compose', '-p', 'sherpa-dev', '-f', 'compose.dev.yml', 'restart', 'worker'], { stdio: 'ignore' })
    await expect(async () => expect(await overrides()).toEqual({})).toPass({ timeout: 120_000 })
    const cur = await (await request.get(`/api/targets/${targetId}/current-compose`)).json() as { composeText: string }
    expect(cur.composeText).toContain('image: busybox:1.37')
  }
  finally {
    await request.post(`/api/projects/${id}/removal`, { data: { mode: 'delete', confirm: slug }, headers }).catch(() => null)
  }
})
