/**
 * Plan d'adressage, sur l'infrastructure de dev (serveur agent-local) : réseau d'une stack Compose
 * lancée hors console, déplacé en direct dans un autre sous-réseau ; conteneurs non redémarrés,
 * résolution par nom conservée, sous-réseau gardé par un « docker compose up » ultérieur.
 */
import { execFileSync } from 'node:child_process'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from './fixtures'

const docker = (...args: string[]) => execFileSync('docker', args, { encoding: 'utf8' }).trim()

test('déplacement en direct du réseau d\'une stack externe : sans redémarrage, noms conservés, gardé par compose up', async ({ page, request }) => {
  test.setTimeout(300_000)
  const { csrfToken } = await (await request.get('/api/auth/me')).json() as { csrfToken: string }
  const headers = { 'x-csrf-token': csrfToken }
  const servers = await (await request.get('/api/servers?pageSize=100')).json() as { items: { id: string, name: string }[] }
  const server = servers.items.find(s => s.name === 'agent-local')
  test.skip(!server, 'serveur agent-local absent')
  const detail = await (await request.get(`/api/servers/${server!.id}`)).json() as { endpoints: { id: string, enabled: boolean, environments: unknown[] }[] }
  const ep = detail.endpoints.find(e => e.enabled && e.environments.length)!

  const project = `extnet${Date.now().toString(36)}`
  const dir = mkdtempSync(join(tmpdir(), 'extnet-'))
  writeFileSync(join(dir, 'compose.yml'), 'services:\n  a:\n    image: busybox:1.37\n    command: ["sleep", "3600"]\n  b:\n    image: busybox:1.37\n    command: ["sleep", "3600"]\n')
  const compose = (...args: string[]) => docker('compose', '-p', project, '-f', join(dir, 'compose.yml'), ...args)
  const net = `${project}_default`
  const subnetOf = () => docker('network', 'inspect', '-f', '{{range .IPAM.Config}}{{.Subnet}}{{end}}', net)
  compose('up', '-d')
  try {
    const startedA = docker('inspect', '-f', '{{.State.StartedAt}}', `${project}-a-1`)
    const plan = await (await request.get(`/api/endpoints/${ep.id}/address-plan`)).json() as { networks: { name: string, owner: { kind: string, stack?: string }, issues: { kind: string }[], movable: boolean, moveMode: string }[] }
    const n = plan.networks.find(x => x.name === net)!
    expect(n).toMatchObject({ owner: { kind: 'compose', stack: project }, movable: true, moveMode: 'live' })
    expect(n.issues.some(i => i.kind === 'oversized')).toBe(true)

    // Prévisualisation (aucun changement), sous-réseau occupé refusé, puis déplacement.
    const dry = await request.post(`/api/endpoints/${ep.id}/address-plan/move`, { data: { network: net, subnet: '10.233.0.0/28', dryRun: true }, headers })
    expect(dry.status(), await dry.text()).toBe(200)
    expect(subnetOf()).not.toBe('10.233.0.0/28')
    const clash = await request.post(`/api/endpoints/${ep.id}/address-plan/move`, { data: { network: net, subnet: subnetOf().replace(/\/\d+$/, '/28') === subnetOf() ? '0.0.0.0/8' : docker('network', 'inspect', '-f', '{{range .IPAM.Config}}{{.Subnet}}{{end}}', 'bridge') }, headers })
    expect(clash.status()).toBe(422)
    const moved = await request.post(`/api/endpoints/${ep.id}/address-plan/move`, { data: { network: net, subnet: '10.233.0.0/28' }, headers })
    expect(moved.status(), await moved.text()).toBe(200)

    expect(subnetOf()).toBe('10.233.0.0/28')
    expect(docker('inspect', '-f', '{{.State.StartedAt}}', `${project}-a-1`)).toBe(startedA)
    expect(docker('exec', `${project}-a-1`, 'ping', '-c1', '-W2', 'b')).toContain('10.233.0.')

    // Un nouveau « docker compose up » garde le sous-réseau (labels Compose conservés).
    compose('up', '-d')
    expect(subnetOf()).toBe('10.233.0.0/28')
    expect(docker('exec', `${project}-a-1`, 'ping', '-c1', '-W2', 'b')).toContain('10.233.0.')

    // Interface : plan d'adressage affiché sur la fiche serveur.
    await page.goto(`/servers/${server!.id}?tab=networks&endpoint=${ep.id}`)
    await expect(page.getByRole('heading', { name: 'Plan d\'adressage' })).toBeVisible()
    await expect(page.getByText(net, { exact: true })).toBeVisible({ timeout: 20_000 })
  }
  finally {
    compose('down')
  }
})

test('plage enregistrée depuis la fiche : « prochain sous-réseau libre » proposé aussitôt au déplacement', async ({ page, request }) => {
  test.setTimeout(300_000)
  const { csrfToken } = await (await request.get('/api/auth/me')).json() as { csrfToken: string }
  const headers = { 'x-csrf-token': csrfToken }
  const servers = await (await request.get('/api/servers?pageSize=100')).json() as { items: { id: string, name: string }[] }
  const server = servers.items.find(s => s.name === 'agent-local')
  test.skip(!server, 'serveur agent-local absent')
  const detail = await (await request.get(`/api/servers/${server!.id}`)).json() as { endpoints: { id: string, enabled: boolean, environments: unknown[] }[] }
  const ep = detail.endpoints.find(e => e.enabled && e.environments.length)!
  const before = await (await request.get(`/api/endpoints/${ep.id}/network-pool`)).json() as { pool: unknown }
  await request.put(`/api/endpoints/${ep.id}/network-pool`, { data: { pool: null }, headers })

  const project = `poolui${Date.now().toString(36)}`
  const dir = mkdtempSync(join(tmpdir(), 'poolui-'))
  writeFileSync(join(dir, 'compose.yml'), 'services:\n  a:\n    image: busybox:1.37\n    command: ["sleep", "3600"]\n')
  const compose = (...args: string[]) => docker('compose', '-p', project, '-f', join(dir, 'compose.yml'), ...args)
  compose('up', '-d')
  try {
    await page.goto(`/servers/${server!.id}?tab=networks&endpoint=${ep.id}`)
    await expect(page.getByText(`${project}_default`, { exact: true })).toBeVisible({ timeout: 20_000 })

    // Plage enregistrée dans l'éditeur de la même page.
    await page.getByRole('checkbox', { name: 'Attribuer les sous-réseaux depuis une plage' }).check()
    await page.locator('#np-base').fill('10.234.0.0/24')
    await page.locator('section', { has: page.getByRole('heading', { name: 'Plage des sous-réseaux' }) }).getByRole('button', { name: 'Enregistrer' }).click()
    await expect(page.getByText(/Plage enregistrée/)).toBeVisible()

    // Déplacement : option de la plage disponible, choisie, et plan dans la plage.
    await page.getByRole('row', { name: new RegExp(`${project}_default`) }).getByRole('button', { name: 'Déplacer…' }).click()
    const dialog = page.getByRole('dialog')
    const poolChoice = dialog.getByRole('radio', { name: /Prochain sous-réseau libre de la plage \(10\.234\.0\.0\/24/ })
    await expect(poolChoice).toBeEnabled()
    await expect(poolChoice).toBeChecked()
    await expect(dialog.getByText(/→ 10\.234\.0\.\d+\/27/)).toBeVisible({ timeout: 20_000 })
  }
  finally {
    compose('down')
    await request.put(`/api/endpoints/${ep.id}/network-pool`, { data: { pool: before.pool }, headers }).catch(() => null)
  }
})

test('réseaux non déplaçables : ceux de la console elle-même et ceux reliés à Traefik', async ({ request }) => {
  const { csrfToken } = await (await request.get('/api/auth/me')).json() as { csrfToken: string }
  const servers = await (await request.get('/api/servers?pageSize=100')).json() as { items: { id: string, name: string }[] }
  const server = servers.items.find(s => s.name === 'agent-local')
  test.skip(!server, 'serveur agent-local absent')
  const detail = await (await request.get(`/api/servers/${server!.id}`)).json() as { endpoints: { id: string, enabled: boolean, environments: unknown[] }[] }
  const ep = detail.endpoints.find(e => e.enabled && e.environments.length)!
  const plan = await (await request.get(`/api/endpoints/${ep.id}/address-plan`)).json() as { networks: { name: string, containers: string[], movable: boolean, notMovableReason: string | null }[] }

  // La console de dev tourne sur l'hôte qu'elle pilote : ses réseaux sont protégés.
  const consoleNets = plan.networks.filter(n => n.containers.some(c => c.startsWith('sherpa-dev-app')))
  expect(consoleNets.length).toBeGreaterThan(0)
  for (const n of consoleNets) expect(n).toMatchObject({ movable: false, notMovableReason: expect.stringContaining('console elle-même') })

  // Réseaux où Traefik est branché : jamais déplaçables (raison « Traefik », ou « console » s'ils sont partagés).
  const traefikNames = execFileSync('docker', ['ps', '--format', '{{.Names}}\t{{.Image}}'], { encoding: 'utf8' }).split('\n')
    .filter(l => /\t(.*\/)?traefik(:|@|$)/i.test(l)).map(l => l.split('\t')[0]!)
  const traefikNets = plan.networks.filter(n => n.containers.some(c => traefikNames.includes(c)))
  if (traefikNames.length) expect(traefikNets.length).toBeGreaterThan(0)
  for (const n of traefikNets) expect(n).toMatchObject({ movable: false, notMovableReason: expect.stringMatching(/Traefik|console elle-même/) })

  // Réseau relié à un Traefik seulement (jetable) : raison « Traefik ».
  const net = `tkonly${Date.now().toString(36)}`
  execFileSync('docker', ['network', 'create', net])
  execFileSync('docker', ['run', '-d', '--name', `${net}-traefik`, '--network', net, 'traefik:v3.6', '--entrypoints.web.address=:80'])
  try {
    const p2 = await (await request.get(`/api/endpoints/${ep.id}/address-plan`)).json() as { networks: { name: string, movable: boolean, notMovableReason: string | null }[] }
    expect(p2.networks.find(n => n.name === net)).toMatchObject({ movable: false, notMovableReason: expect.stringContaining('Traefik') })
    expect((await request.post(`/api/endpoints/${ep.id}/address-plan/move`, { data: { network: net, subnet: '10.235.0.0/27' }, headers: { 'x-csrf-token': csrfToken } })).status()).toBe(422)
  }
  finally {
    execFileSync('docker', ['rm', '-f', `${net}-traefik`])
    execFileSync('docker', ['network', 'rm', net])
  }

  for (const n of [...consoleNets, ...traefikNets].slice(0, 3)) {
    const r = await request.post(`/api/endpoints/${ep.id}/address-plan/move`, { data: { network: n.name, subnet: '10.235.0.0/27' }, headers: { 'x-csrf-token': csrfToken } })
    expect(r.status()).toBe(422)
  }
})
