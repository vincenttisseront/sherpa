/**
 * Service suspendu depuis l'onglet Conteneurs (ex. varken en échec qui bloque chaque mise à jour) :
 * retiré de la stack (conteneur supprimé, volume gardé), plus contrôlé, puis repris avec ses données.
 */
import { execFileSync } from 'node:child_process'
import { expect, test } from './fixtures'

const docker = (...args: string[]) => execFileSync('docker', args, { encoding: 'utf8' }).trim()

test('service en échec suspendu puis repris : la stack redevient saine, données conservées', async ({ page, request }) => {
  test.setTimeout(600_000)
  const { csrfToken } = await (await request.get('/api/auth/me')).json() as { csrfToken: string }
  const headers = { 'x-csrf-token': csrfToken }
  const servers = await (await request.get('/api/servers?pageSize=100')).json() as { items: { id: string, name: string }[] }
  const server = servers.items.find(s => s.name === 'agent-local')
  test.skip(!server, 'serveur agent-local absent')
  const detail = await (await request.get(`/api/servers/${server!.id}`)).json() as { endpoints: { id: string, enabled: boolean, environments: { key: string }[] }[] }
  const ep = detail.endpoints.find(e => e.enabled && e.environments.length)!
  const env = ep.environments[0]!.key
  const slug = `sus-${Date.now().toString(36)}`
  const stack = `${slug}-${env}`
  const { id } = await (await request.post('/api/projects', { data: { slug, name: `Suspension ${slug}`, target: { endpointId: ep.id, environmentKey: env } }, headers })).json() as { id: string }
  try {
    // « flaky » sort en erreur tant que /data/ok n'existe pas : redémarre en boucle, stack dégradée.
    await page.goto(`/projects/${id}`)
    await expect(async () => {
      await page.getByRole('button', { name: 'Nouveau déploiement' }).click({ timeout: 5000 })
      await expect(page.getByRole('textbox', { name: 'Contenu du fichier Compose' })).toBeVisible({ timeout: 3000 })
    }).toPass({ timeout: 30_000 })
    await page.getByRole('textbox', { name: 'Contenu du fichier Compose' }).fill('services:\n  app:\n    image: busybox:1.37\n    command: ["sleep", "3600"]\n  flaky:\n    image: busybox:1.37\n    command: ["sh", "-c", "test -f /data/ok && sleep 3600"]\n    restart: unless-stopped\n    volumes: [data:/data]\nvolumes:\n  data: {}\n')
    await page.getByRole('button', { name: 'Analyser ce Compose' }).click({ timeout: 10_000 })
    await page.getByRole('button', { name: 'Déployer', exact: true }).click({ timeout: 60_000 })
    await page.getByRole('dialog').getByRole('button', { name: 'Déployer' }).click({ timeout: 10_000 })
    await expect(page.getByRole('log')).toContainText(/Statut : (DEGRADED|FAILED)/, { timeout: 300_000 })
    docker('run', '--rm', '-v', `${stack}_data:/data`, 'busybox:1.37', 'sh', '-c', 'echo garde > /data/memo')

    // Suspension depuis l'onglet Conteneurs : redéploiement, flaky retiré, stack saine.
    await page.goto(`/projects/${id}`)
    await page.getByRole('tab', { name: 'Conteneurs' }).click()
    await page.getByRole('button', { name: 'Suspendre flaky' }).click({ timeout: 30_000 })
    const put = page.waitForResponse(r => r.url().includes('/suspended-services'))
    await page.getByRole('dialog').getByRole('button', { name: 'Suspendre', exact: true }).click()
    const res = await put
    expect(res.status(), await res.text()).toBe(200)
    await page.waitForURL(/\/deployments\//, { timeout: 30_000 })
    await expect(page.getByRole('log')).toContainText(/Statut : (HEALTHY|DEGRADED|FAILED)/, { timeout: 300_000 })
    await expect(page.getByRole('log')).toContainText('Statut : HEALTHY')
    expect(docker('ps', '-a', '--filter', `label=com.docker.compose.project=${stack}`, '--format', '{{.Label "com.docker.compose.service"}}')).toBe('app')

    await page.goto(`/projects/${id}`)
    await page.getByRole('tab', { name: 'Conteneurs' }).click()
    await expect(page.getByText('Services suspendus')).toBeVisible({ timeout: 30_000 })
    await expect(page.getByText('absent')).toHaveCount(0)

    // Reprise (après correction) : flaky revient avec ses données.
    docker('run', '--rm', '-v', `${stack}_data:/data`, 'busybox:1.37', 'touch', '/data/ok')
    await page.getByRole('button', { name: 'Reprendre' }).click()
    await page.getByRole('dialog').getByRole('button', { name: 'Reprendre', exact: true }).click()
    await page.waitForURL(/\/deployments\//, { timeout: 30_000 })
    await expect(page.getByRole('log')).toContainText(/Statut : (HEALTHY|DEGRADED|FAILED)/, { timeout: 300_000 })
    await expect(page.getByRole('log')).toContainText('Statut : HEALTHY')
    expect(docker('exec', `${stack}-flaky-1`, 'cat', '/data/memo')).toBe('garde')
  }
  finally {
    await request.post(`/api/projects/${id}/removal`, { data: { mode: 'delete', confirm: slug }, headers }).catch(() => null)
  }
})
