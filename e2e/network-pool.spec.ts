/**
 * Plage d'adresses des réseaux de projets, sur l'infrastructure de dev (serveur agent-local) :
 * plage posée sur l'endpoint, projet déployé, sous-réseaux /28 réellement créés par Docker,
 * attributions affichées puis libérées à la suppression du projet ; plage d'origine restaurée.
 */
import { execFileSync } from 'node:child_process'
import { expect, test } from './fixtures'

const docker = (...args: string[]) => execFileSync('docker', args, { encoding: 'utf8' }).trim()
const COMPOSE = `services:
  web:
    image: busybox:1.37
    command: ["sleep", "3600"]
  worker:
    image: busybox:1.37
    command: ["sleep", "3600"]
    networks: [default, back]
networks:
  back: {}
`

test('sous-réseaux des projets : plage de l\'endpoint, /28 attribués, libérés à la suppression', async ({ page, request }) => {
  test.setTimeout(600_000)
  const { csrfToken } = await (await request.get('/api/auth/me')).json() as { csrfToken: string }
  const headers = { 'x-csrf-token': csrfToken }
  const servers = await (await request.get('/api/servers?pageSize=100')).json() as { items: { id: string, name: string }[] }
  const server = servers.items.find(s => s.name === 'agent-local')
  test.skip(!server, 'serveur agent-local absent')
  const detail = await (await request.get(`/api/servers/${server!.id}`)).json() as { endpoints: { id: string, enabled: boolean, environments: { key: string }[] }[] }
  const ep = detail.endpoints.find(e => e.enabled && e.environments.length)!
  const env = ep.environments[0]!.key
  const before = await (await request.get(`/api/endpoints/${ep.id}/network-pool`)).json() as { pool: unknown }

  // Plage invalide refusée, puis plage de test posée.
  expect((await request.put(`/api/endpoints/${ep.id}/network-pool`, { data: { pool: { base: '10.231.0.0/24', prefix: 20, avoid: [] } }, headers })).status()).toBe(422)
  const set = await request.put(`/api/endpoints/${ep.id}/network-pool`, { data: { pool: { base: '10.231.0.0/24', prefix: 28, avoid: ['10.231.0.0/28'] } }, headers })
  expect(set.status(), await set.text()).toBe(200)

  const slug = `net-${Date.now().toString(36)}`
  const created = await request.post('/api/projects', { data: { slug, name: `Réseaux ${slug}`, target: { endpointId: ep.id, environmentKey: env } }, headers })
  expect(created.status(), await created.text()).toBe(201)
  const project = await created.json() as { id: string }
  const stack = `${slug}-${env}`
  try {
    await page.goto(`/projects/${project.id}`)
    // Clic avant hydratation sans effet : réessayé jusqu'à l'ouverture du formulaire.
    await expect(async () => {
      await page.getByRole('button', { name: 'Nouveau déploiement' }).click({ timeout: 5000 })
      await expect(page.getByRole('textbox', { name: 'Contenu du fichier Compose' })).toBeVisible({ timeout: 3000 })
    }).toPass({ timeout: 30_000 })
    await page.getByRole('textbox', { name: 'Contenu du fichier Compose' }).fill(COMPOSE, { timeout: 10_000 })
    await page.getByRole('button', { name: 'Analyser ce Compose' }).click({ timeout: 10_000 })
    await expect(page.getByRole('heading', { name: /Analyse/ })).toBeVisible({ timeout: 60_000 })
    await expect(page.getByText(/sous-réseau 10\.231\.0\./).first()).toBeVisible()
    await page.getByRole('button', { name: 'Déployer', exact: true }).click({ timeout: 30_000 })
    await page.getByRole('dialog').getByRole('button', { name: 'Déployer' }).click({ timeout: 10_000 })
    await expect(page.getByRole('log')).toContainText('Statut : HEALTHY', { timeout: 300_000 })

    // Réseaux réellement créés par Docker : /28 de la plage, hors de la plage à éviter.
    const subnetOf = (n: string) => docker('network', 'inspect', '-f', '{{range .IPAM.Config}}{{.Subnet}}{{end}}', n)
    const def = subnetOf(`${stack}_default`)
    const back = subnetOf(`${stack}_back`)
    expect(def).toMatch(/^10\.231\.0\.\d+\/28$/)
    expect(back).toMatch(/^10\.231\.0\.\d+\/28$/)
    expect(def).not.toBe(back)
    expect([def, back]).not.toContain('10.231.0.0/28')

    const pool = await (await request.get(`/api/endpoints/${ep.id}/network-pool`)).json() as { capacity: number, allocations: { network: string, subnet: string }[] }
    expect(pool.capacity).toBe(16)
    expect(pool.allocations.filter(a => a.subnet === def || a.subnet === back).map(a => a.network).sort()).toEqual(['back', 'default'])

    // Plan d'adressage : réseau du projet déplacé dans la plage, par redéploiement.
    const target = (pool.allocations.find(a => a.subnet === back) ? '10.231.0.240/28' : '')
    const mv = await request.post(`/api/endpoints/${ep.id}/address-plan/move`, { data: { network: `${stack}_back`, subnet: target }, headers })
    expect(mv.status(), await mv.text()).toBe(200)
    const { deploymentId, plan: mvPlan } = await mv.json() as { deploymentId: string, plan: { mode: string } }
    expect(mvPlan.mode).toBe('redeploy')
    await page.goto(`/deployments/${deploymentId}`)
    await expect(page.getByRole('log')).toContainText('Statut : HEALTHY', { timeout: 300_000 })
    expect(subnetOf(`${stack}_back`)).toBe('10.231.0.240/28')
    expect(subnetOf(`${stack}_default`)).toBe(def)

    // Fiche serveur : section des sous-réseaux.
    await page.goto(`/servers/${server!.id}?tab=networks&endpoint=${ep.id}`)
    await expect(page.getByRole('heading', { name: 'Plage des sous-réseaux' })).toBeVisible()
    await expect(page.getByText(def, { exact: true }).first()).toBeVisible()
  }
  finally {
    const removal = await request.post(`/api/projects/${project.id}/removal`, { data: { mode: 'delete', confirm: slug }, headers }).catch(() => null)
    if (removal?.ok()) {
      for (let i = 0; i < 60; i++) {
        if (!docker('ps', '-aq', '--filter', `label=com.docker.compose.project=${stack}`)) break
        await new Promise(r => setTimeout(r, 2000))
      }
    }
    await request.put(`/api/endpoints/${ep.id}/network-pool`, { data: { pool: before.pool }, headers }).catch(() => null)
  }
  // Suppression du projet : attributions libérées.
  for (let i = 0; i < 30; i++) {
    const after = await (await request.get(`/api/endpoints/${ep.id}/network-pool`)).json() as { allocations: { project: string }[] }
    if (!after.allocations.some(a => a.project.includes(slug))) return
    await new Promise(r => setTimeout(r, 2000))
  }
  throw new Error('Attributions non libérées après la suppression du projet')
})
