/**
 * Service laissé hors de la console (ex. Traefik d'une stack reprise) : retiré du Compose déployé,
 * son conteneur est détaché de la stack au déploiement et continue de tourner.
 */
import { execFileSync } from 'node:child_process'
import { expect, test } from './fixtures'

const docker = (...args: string[]) => execFileSync('docker', args, { encoding: 'utf8' }).trim()

test('service non géré : plus de justification demandée, conteneur détaché et toujours en service', async ({ page, request }) => {
  test.setTimeout(600_000)
  const { csrfToken } = await (await request.get('/api/auth/me')).json() as { csrfToken: string }
  const headers = { 'x-csrf-token': csrfToken }
  const servers = await (await request.get('/api/servers?pageSize=100')).json() as { items: { id: string, name: string }[] }
  const server = servers.items.find(s => s.name === 'agent-local')
  test.skip(!server, 'serveur agent-local absent')
  const detail = await (await request.get(`/api/servers/${server!.id}`)).json() as { endpoints: { id: string, enabled: boolean, environments: { key: string }[] }[] }
  const ep = detail.endpoints.find(e => e.enabled && e.environments.length)!
  const env = ep.environments[0]!.key
  const slug = `exc-${Date.now().toString(36)}`
  const stack = `${slug}-${env}`
  // Réseau dont la configuration change au second déploiement (cas de seedbox : réseau à recréer
  // alors que le service non géré y est encore branché).
  const composeFor = (n: number) => `services:\n  proxy:\n    image: busybox:1.37\n    command: ["sleep", "3600"]\n    networks: [net]\n  app:\n    image: busybox:1.37\n    command: ["sleep", "3600"]\n    depends_on: [proxy]\n    networks: [net]\nnetworks:\n  net:\n    ipam:\n      config:\n        - subnet: 10.24${n}.7.0/24\n`
  const { id } = await (await request.post('/api/projects', { data: { slug, name: `Exclusion ${slug}`, target: { endpointId: ep.id, environmentKey: env } }, headers })).json() as { id: string }
  const deploy = async (exclude: boolean, compose: string) => {
    await page.goto(`/projects/${id}`)
    await expect(async () => {
      await page.getByRole('button', { name: 'Nouveau déploiement' }).click({ timeout: 5000 })
      await expect(page.getByRole('textbox', { name: 'Contenu du fichier Compose' })).toBeVisible({ timeout: 3000 })
    }).toPass({ timeout: 30_000 })
    await page.getByRole('textbox', { name: 'Contenu du fichier Compose' }).fill(compose)
    await page.getByRole('button', { name: 'Analyser ce Compose' }).click({ timeout: 10_000 })
    await expect(page.getByRole('heading', { name: 'Services gérés par la console' })).toBeVisible({ timeout: 60_000 })
    if (exclude) {
      await page.getByLabel('Service à ne pas gérer').selectOption('proxy')
      await page.getByRole('button', { name: 'Ne pas gérer ce service' }).click()
      await page.getByRole('dialog').getByRole('button', { name: 'Ne pas gérer' }).click()
      await expect(page.getByText('non géré', { exact: true })).toBeVisible({ timeout: 60_000 })
    }
    await page.getByRole('button', { name: 'Déployer', exact: true }).click({ timeout: 30_000 })
    await page.getByRole('dialog').getByRole('button', { name: 'Déployer' }).click({ timeout: 10_000 })
    await expect(page.getByRole('log')).toContainText('Statut : HEALTHY', { timeout: 300_000 })
  }
  try {
    await deploy(false, composeFor(1))
    // Projet déjà déployé : « Nouveau déploiement » repart du Compose de la release active.
    await page.goto(`/projects/${id}`)
    await page.getByRole('button', { name: 'Nouveau déploiement' }).click()
    await expect(page.getByRole('textbox', { name: 'Contenu du fichier Compose' })).toHaveValue(composeFor(1), { timeout: 15_000 })
    await expect(page.getByText(/Compose de la release #1 \(active\)/)).toBeVisible()
    const before = docker('inspect', '-f', '{{.Id}}', `${stack}-proxy-1`)
    await deploy(true, composeFor(2))
    await expect(page.getByRole('log')).toContainText(`conteneur ${stack}-proxy-1 détaché de la stack`)
    await expect(page.getByRole('log')).toContainText(`débranchés le temps de recréer ses réseaux, puis rebranchés : ${stack}-proxy-1`)
    expect(docker('network', 'inspect', '-f', '{{range .IPAM.Config}}{{.Subnet}}{{end}}', `${stack}_net`)).toBe('10.242.7.0/24')
    // Toujours en service, hors du projet Compose ; la stack ne compte plus que « app ».
    expect(docker('inspect', '-f', '{{.State.Running}} {{index .Config.Labels "com.docker.compose.project"}}|{{index .Config.Labels "platform.detached-from"}}', `${stack}-proxy-1`)).toBe(`true |${stack}`)
    expect(docker('inspect', '-f', '{{.Id}}', `${stack}-proxy-1`)).not.toBe(before)
    expect(docker('ps', '--filter', `label=com.docker.compose.project=${stack}`, '--format', '{{.Names}}')).toBe(`${stack}-app-1`)
    // Toujours joignable par son nom de service depuis la stack.
    expect(docker('exec', `${stack}-app-1`, 'ping', '-c1', '-W2', 'proxy')).toContain('1 packets received')
  }
  finally {
    execFileSync('docker', ['rm', '-f', `${stack}-proxy-1`], { stdio: 'ignore' })
    await request.post(`/api/projects/${id}/removal`, { data: { mode: 'delete', confirm: slug }, headers }).catch(() => null)
  }
})
