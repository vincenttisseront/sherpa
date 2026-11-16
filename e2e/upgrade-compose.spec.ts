/**
 * Mise à niveau d'une image réussie : la nouvelle version est reportée dans le Compose du projet
 * (plus de surcharge cachée), et « Nouveau déploiement » repart de ce Compose à jour.
 */
import { expect, test } from './fixtures'

test('mise à niveau : Compose du projet mis à jour, surcharge retirée', async ({ page, request }) => {
  test.setTimeout(600_000)
  const { csrfToken } = await (await request.get('/api/auth/me')).json() as { csrfToken: string }
  const headers = { 'x-csrf-token': csrfToken }
  const servers = await (await request.get('/api/servers?pageSize=100')).json() as { items: { id: string, name: string }[] }
  const server = servers.items.find(s => s.name === 'agent-local')
  test.skip(!server, 'serveur agent-local absent')
  const detail = await (await request.get(`/api/servers/${server!.id}`)).json() as { endpoints: { id: string, enabled: boolean, environments: { key: string }[] }[] }
  const ep = detail.endpoints.find(e => e.enabled && e.environments.length)!
  const env = ep.environments[0]!.key
  const slug = `upc-${Date.now().toString(36)}`
  const { id } = await (await request.post('/api/projects', { data: { slug, name: `Upgrade ${slug}`, target: { endpointId: ep.id, environmentKey: env } }, headers })).json() as { id: string }
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

    const targetId = ((await (await request.get(`/api/projects/${id}`)).json()) as { targets: { id: string }[] }).targets[0]!.id
    const up = await request.post(`/api/targets/${targetId}/upgrade`, { data: { services: [{ service: 'app', tag: '1.37' }] }, headers })
    expect(up.status(), await up.text()).toBe(202)
    await page.goto(`/deployments/${(await up.json() as { deploymentId: string }).deploymentId}`)
    await expect(page.getByRole('log')).toContainText(/Statut : (HEALTHY|FAILED|ROLLED_BACK)/, { timeout: 300_000 })
    await expect(page.getByRole('log')).toContainText('Compose du projet mis à jour avec les nouvelles images : app')

    // Anciennes détections de busybox:1.36 retirées : seule l'image en service reste analysée.
    // L'analyse suit le déploiement (sans blocage) : on attend celle de la nouvelle image.
    const analysed = async () => ((await (await request.get(`/api/targets/${targetId}/vulnerabilities`)).json()) as { images: { image: string }[] }).images.map(i => i.image)
    await expect.poll(analysed, { timeout: 180_000, intervals: [2000] }).toEqual(['busybox:1.37'])

    const cur = await (await request.get(`/api/targets/${targetId}/current-compose`)).json() as { composeText: string }
    expect(cur.composeText).toContain('image: busybox:1.37')
    const project = await (await request.get(`/api/projects/${id}`)).json() as { targets: { composeOverrides: { images: Record<string, unknown> } }[] }
    expect(project.targets[0]!.composeOverrides.images).toEqual({})

    await page.goto(`/projects/${id}`)
    await page.getByRole('button', { name: 'Nouveau déploiement' }).click()
    await expect(page.getByRole('textbox', { name: 'Contenu du fichier Compose' })).toHaveValue(/image: busybox:1\.37/, { timeout: 15_000 })
  }
  finally {
    await request.post(`/api/projects/${id}/removal`, { data: { mode: 'delete', confirm: slug }, headers }).catch(() => null)
  }
})
