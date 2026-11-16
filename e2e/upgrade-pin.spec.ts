/**
 * Image absente de son registre (construite sur l'hôte, tag inexistant sur Docker Hub) :
 * « Mises à niveau… » propose de la figer sur la dernière version publiée ; si la version figée
 * casse (healthcheck en échec), retour automatique à l'image locale, sans la redemander au registre.
 */
import { execFileSync } from 'node:child_process'
import { expect, test } from './fixtures'

const LOCAL = 'busybox:local-e2e-pin'

test('image absente du registre : version fixe proposée, retour à l\'image locale si elle casse', async ({ page, request }) => {
  test.setTimeout(600_000)
  const { csrfToken } = await (await request.get('/api/auth/me')).json() as { csrfToken: string }
  const headers = { 'x-csrf-token': csrfToken }
  const servers = await (await request.get('/api/servers?pageSize=100')).json() as { items: { id: string, name: string }[] }
  const server = servers.items.find(s => s.name === 'agent-local')
  test.skip(!server, 'serveur agent-local absent')
  // Image locale : un fichier témoin que la version publiée n'a pas (healthcheck).
  execFileSync('docker', ['build', '-q', '-t', LOCAL, '-'], { input: 'FROM busybox:1.36\nRUN touch /marker\n' })
  const detail = await (await request.get(`/api/servers/${server!.id}`)).json() as { endpoints: { id: string, enabled: boolean, environments: { key: string }[] }[] }
  const ep = detail.endpoints.find(e => e.enabled && e.environments.length)!
  const slug = `pin-${Date.now().toString(36)}`
  const { id } = await (await request.post('/api/projects', { data: { slug, name: `Pin ${slug}`, target: { endpointId: ep.id, environmentKey: ep.environments[0]!.key } }, headers })).json() as { id: string }
  try {
    await page.goto(`/projects/${id}`)
    await expect(async () => {
      await page.getByRole('button', { name: 'Nouveau déploiement' }).click({ timeout: 5000 })
      await expect(page.getByRole('textbox', { name: 'Contenu du fichier Compose' })).toBeVisible({ timeout: 3000 })
    }).toPass({ timeout: 30_000 })
    await page.getByRole('textbox', { name: 'Contenu du fichier Compose' }).fill(`services:\n  app:\n    image: ${LOCAL}\n    command: ["sleep", "3600"]\n    healthcheck:\n      test: ["CMD", "test", "-f", "/marker"]\n      interval: 2s\n      retries: 2\n      start_period: 1s\n`)
    await page.getByRole('button', { name: 'Analyser ce Compose' }).click({ timeout: 10_000 })
    await page.getByRole('button', { name: 'Déployer', exact: true }).click({ timeout: 60_000 })
    await page.getByRole('dialog').getByRole('button', { name: 'Déployer' }).click({ timeout: 10_000 })
    await expect(page.getByRole('log')).toContainText('Statut : HEALTHY', { timeout: 300_000 })
    const targetId = ((await (await request.get(`/api/projects/${id}`)).json()) as { targets: { id: string }[] }).targets[0]!.id

    // Plan : image locale, version fixe proposée (dernière version publiée de busybox).
    const plan = await (await request.get(`/api/targets/${targetId}/upgrade`)).json() as { services: { service: string, kind: string, pin: { tag: string, reason: string } | null }[] }
    const app = plan.services.find(s => s.service === 'app')!
    expect(app).toMatchObject({ kind: 'local', pin: { reason: 'absent' } })
    expect(app.pin!.tag).toMatch(/^\d+\.\d+(\.\d+)?$/)

    // Fenêtre « Mises à niveau… » : option proposée avec ses précautions.
    await page.goto(`/projects/${id}?tab=containers`)
    await page.getByRole('button', { name: /Mises à niveau/ }).click({ timeout: 30_000 })
    const dialog = page.getByRole('dialog')
    await dialog.getByLabel('Version cible de app').selectOption(app.pin!.tag, { timeout: 60_000 })
    await expect(dialog.getByText(/Image absente du registre : passage à une version fixe/)).toBeVisible()
    await expect(dialog.getByText(/retour automatique à l'image actuelle si ça casse/)).toBeVisible()

    // La version publiée n'a pas le fichier témoin : healthcheck en échec, retour à l'image locale.
    const up = await request.post(`/api/targets/${targetId}/upgrade`, { data: { services: [{ service: 'app', tag: app.pin!.tag }] }, headers })
    expect(up.status(), await up.text()).toBe(202)
    const depId = (await up.json() as { deploymentId: string }).deploymentId
    await page.goto(`/deployments/${depId}`)
    await expect(page.getByRole('log')).toContainText(/Statut : (HEALTHY|FAILED|ROLLED_BACK|DEGRADED)/, { timeout: 300_000 })
    await expect(page.getByRole('log')).toContainText('Statut : ROLLED_BACK', { timeout: 300_000 })
    const running = execFileSync('docker', ['ps', '--filter', `label=com.docker.compose.project=${slug}-${ep.environments[0]!.key}`, '--format', '{{.Image}} {{.Status}}'], { encoding: 'utf8' }).trim()
    expect(running).toMatch(new RegExp(`^${LOCAL.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} Up`))
  }
  finally {
    await request.post(`/api/projects/${id}/removal`, { data: { mode: 'delete', confirm: slug }, headers }).catch(() => null)
  }
})
