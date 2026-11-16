/**
 * Service web publié directement sur l'hôte : à la configuration du déploiement, le port est retiré
 * et le service exposé par le reverse proxy de l'endpoint (Traefik de dev, *.localhost) ; le port
 * n'est plus publié par le conteneur, et peut être publié de nouveau.
 */
import { execFileSync } from 'node:child_process'
import { expect, test } from './fixtures'

test('port web publié : reverse proxy uniquement, puis publié de nouveau', async ({ page, request }) => {
  test.setTimeout(600_000)
  const { csrfToken } = await (await request.get('/api/auth/me')).json() as { csrfToken: string }
  const headers = { 'x-csrf-token': csrfToken }
  const servers = await (await request.get('/api/servers?pageSize=100')).json() as { items: { id: string, name: string }[] }
  const server = servers.items.find(s => s.name === 'agent-local')
  test.skip(!server, 'serveur agent-local absent')
  const detail = await (await request.get(`/api/servers/${server!.id}`)).json() as { endpoints: { id: string, enabled: boolean, environments: { key: string }[] }[] }
  const ep = detail.endpoints.find(e => e.enabled && e.environments.length)!
  const traefik = ((await (await request.get(`/api/endpoints/${ep.id}/config`)).json()) as { traefik: { allowedDomains: string[] } | null }).traefik
  test.skip(!traefik?.allowedDomains.some(d => d.endsWith('localhost')), 'reverse proxy *.localhost non configuré')
  const env = ep.environments[0]!.key
  const slug = `pub-${Date.now().toString(36)}`
  const { id } = await (await request.post('/api/projects', { data: { slug, name: `Web ${slug}`, target: { endpointId: ep.id, environmentKey: env } }, headers })).json() as { id: string }
  const targetId = ((await (await request.get(`/api/projects/${id}`)).json()) as { targets: { id: string }[] }).targets[0]!.id
  try {
    await page.goto(`/projects/${id}`)
    await expect(async () => {
      await page.getByRole('button', { name: 'Nouveau déploiement' }).click({ timeout: 5000 })
      await expect(page.getByRole('textbox', { name: 'Contenu du fichier Compose' })).toBeVisible({ timeout: 3000 })
    }).toPass({ timeout: 30_000 })
    await page.getByRole('textbox', { name: 'Contenu du fichier Compose' }).fill('services:\n  web:\n    image: traefik/whoami:v1.10\n    ports:\n      - "8089:80"\n')
    await page.getByRole('button', { name: 'Analyser ce Compose' }).click({ timeout: 10_000 })

    // Port web détecté : exposé par le reverse proxy, port retiré.
    await expect(page.getByRole('heading', { name: 'Services web publiés directement sur l\'hôte' })).toBeVisible({ timeout: 60_000 })
    const host = page.getByLabel('Domaine de web')
    await expect(host).toHaveValue(new RegExp(`^web-${slug}-${env}\\.localhost$`))
    await page.getByRole('button', { name: 'Exposer web et ne plus publier le port 8089' }).click()
    await expect(page.getByText('Non publié · reverse proxy')).toBeVisible({ timeout: 60_000 })
    await expect(page.getByRole('heading', { name: 'Services web publiés directement sur l\'hôte' })).toHaveCount(0)
    const t = await (await request.get(`/api/projects/${id}`)).json() as { targets: { composeOverrides?: { unpublishedPorts?: { service: string, published: number }[] }, exposures?: { host: string }[] }[] }
    expect(t.targets[0]!.composeOverrides?.unpublishedPorts).toMatchObject([{ service: 'web', published: 8089, protocol: 'tcp' }])

    // Déployé sans port publié, routé par Traefik.
    await page.getByRole('button', { name: 'Déployer', exact: true }).click({ timeout: 60_000 })
    await page.getByRole('dialog').getByRole('button', { name: 'Déployer' }).click({ timeout: 10_000 })
    await expect(page.getByRole('log')).toContainText(/Statut : (HEALTHY|FAILED|DEGRADED)/, { timeout: 300_000 })
    await expect(page.getByRole('log')).toContainText('Statut : HEALTHY')
    const container = `${slug}-${env}-web-1`
    expect(execFileSync('docker', ['inspect', '-f', '{{json .HostConfig.PortBindings}}', container], { encoding: 'utf8' }).trim()).toMatch(/^(\{\}|null)$/)
    expect(execFileSync('docker', ['inspect', '-f', '{{json .Config.Labels}}', container], { encoding: 'utf8' })).toContain(`web-${slug}-${env}.localhost`)

    // Publié de nouveau : port de retour à l'analyse suivante.
    const back = await request.put(`/api/targets/${targetId}/unpublished-ports`, { data: { service: 'web', published: 8089, protocol: 'tcp', unpublished: false }, headers })
    expect(back.status(), await back.text()).toBe(200)
    expect((await back.json() as { unpublishedPorts: unknown[] }).unpublishedPorts).toEqual([])
  }
  finally {
    await request.post(`/api/projects/${id}/removal`, { data: { mode: 'delete', confirm: slug }, headers }).catch(() => null)
  }
})
