/**
 * Mise à niveau d'un service à données avec sauvegarde préalable, sur l'infrastructure de dev :
 * Valkey 8.0 avec des données, mise à niveau en majeure qui échoue (healthcheck qui n'accepte que
 * la 8), retour arrière avec restauration du volume : la 8.0 redémarre et relit ses données
 * (sans sauvegarde, elle ne relirait pas le fichier écrit par la nouvelle version).
 */
import { execFileSync } from 'node:child_process'
import { expect, test } from './fixtures'

const docker = (...args: string[]) => execFileSync('docker', args, { encoding: 'utf8' }).trim()
const COMPOSE = `services:
  cache:
    image: valkey/valkey:8.0-alpine
    volumes:
      - data:/data
    healthcheck:
      test: ["CMD-SHELL", "valkey-cli INFO server | grep -q '^valkey_version:8\\\\.'"]
      interval: 3s
      retries: 5
volumes:
  data: {}
`

test('mise à niveau d\'un service à données : sauvegarde, échec, retour avec données restaurées', async ({ page, request }) => {
  test.setTimeout(900_000)
  const { csrfToken } = await (await request.get('/api/auth/me')).json() as { csrfToken: string }
  const headers = { 'x-csrf-token': csrfToken }
  const servers = await (await request.get('/api/servers?pageSize=100')).json() as { items: { id: string, name: string }[] }
  const server = servers.items.find(s => s.name === 'agent-local')
  test.skip(!server, 'serveur agent-local absent')
  const detail = await (await request.get(`/api/servers/${server!.id}`)).json() as { endpoints: { id: string, enabled: boolean, environments: { key: string }[] }[] }
  const ep = detail.endpoints.find(e => e.enabled && e.environments.length)!
  const env = ep.environments[0]!.key
  const slug = `bkp-${Date.now().toString(36)}`
  const created = await request.post('/api/projects', { data: { slug, name: `Sauvegarde ${slug}`, target: { endpointId: ep.id, environmentKey: env } }, headers })
  expect(created.status(), await created.text()).toBe(201)
  const project = await created.json() as { id: string }
  const stack = `${slug}-${env}`
  const container = `${stack}-cache-1`
  try {
    await page.goto(`/projects/${project.id}`)
    await page.getByRole('button', { name: 'Nouveau déploiement' }).click({ timeout: 30_000 })
    await page.getByRole('textbox', { name: 'Contenu du fichier Compose' }).fill(COMPOSE, { timeout: 10_000 })
    await page.getByRole('button', { name: 'Analyser ce Compose' }).click({ timeout: 10_000 })
    await expect(page.getByRole('heading', { name: /Analyse/ })).toBeVisible({ timeout: 60_000 })
    await page.getByRole('button', { name: 'Déployer', exact: true }).click({ timeout: 30_000 })
    await page.getByRole('dialog').getByRole('button', { name: 'Déployer' }).click({ timeout: 10_000 })
    await expect(page.getByRole('log')).toContainText('Statut : HEALTHY', { timeout: 300_000 })

    // Données présentes, écrites sur disque.
    docker('exec', container, 'valkey-cli', 'SET', 'clef', 'valeur-avant')
    docker('exec', container, 'valkey-cli', 'SAVE')

    const targets = await (await request.get(`/api/projects/${project.id}`)).json() as { targets: { id: string }[] }
    const targetId = targets.targets[0]!.id
    const plan = await (await request.get(`/api/targets/${targetId}/upgrade`)).json() as { services: { service: string, stateful: boolean, major: { tag: string } | null }[] }
    const cache = plan.services.find(s => s.service === 'cache')!
    expect(cache.stateful).toBe(true)
    test.skip(!cache.major, 'aucune version majeure de Valkey publiée')
    const up = await request.post(`/api/targets/${targetId}/upgrade`, { data: { services: [{ service: 'cache', tag: cache.major!.tag }], confirmMajorData: true, backup: true }, headers })
    expect(up.status(), await up.text()).toBe(202)
    const { deploymentId } = await up.json() as { deploymentId: string }
    await page.goto(`/deployments/${deploymentId}`)
    await expect(page.getByRole('log')).toContainText('Sauvegarde de /data', { timeout: 300_000 })
    await expect(page.getByRole('log')).toContainText('Données de /data restaurées depuis la sauvegarde', { timeout: 600_000 })
    await expect(page.getByRole('log')).toContainText('Statut : ROLLED_BACK', { timeout: 300_000 })

    // Valkey 8.0 de nouveau en service, données relues.
    expect(docker('exec', container, 'valkey-cli', 'INFO', 'server')).toMatch(/valkey_version:8\./)
    expect(docker('exec', container, 'valkey-cli', 'GET', 'clef')).toBe('valeur-avant')
  }
  finally {
    const removal = await request.post(`/api/projects/${project.id}/removal`, { data: { mode: 'delete', confirm: slug }, headers }).catch(() => null)
    if (removal?.ok()) {
      for (let i = 0; i < 60; i++) {
        if (!docker('ps', '-aq', '--filter', `label=com.docker.compose.project=${stack}`)) break
        await new Promise(r => setTimeout(r, 2000))
      }
    }
    try {
      docker('volume', 'rm', '-f', `${stack}_data`)
    }
    catch {
      // Volume encore utilisé : nettoyé au prochain passage.
    }
  }
})
