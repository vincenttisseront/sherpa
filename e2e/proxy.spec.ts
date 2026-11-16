import { execFileSync } from 'node:child_process'
import { expect, test } from './fixtures'

/** Endpoint de l'hôte joint par agent (Traefik et stacks de démonstration), pas l'hôte SSH de test. */
async function agentEndpoint(request: import('@playwright/test').APIRequestContext) {
  const servers = await (await request.get('/api/servers?pageSize=100')).json() as { items: { id: string, transport: string }[] }
  const agents = new Set(servers.items.filter(s => s.transport !== 'ssh').map(s => s.id))
  const live = await (await request.get('/api/live')).json() as { serverId: string, endpointId: string }[]
  return live.find(e => agents.has(e.serverId))!
}

test('proxy et expositions : Traefik lu, routes, pré-remplissage sans enregistrement', async ({ page, request }) => {
  const ep = await agentEndpoint(request)
  await page.goto(`/servers/${ep!.serverId}?tab=proxy&endpoint=${ep!.endpointId}`)
  await expect(page.getByRole('heading', { name: 'Expositions' })).toBeVisible({ timeout: 20_000 })
  await expect(page.getByRole('heading', { name: /Traefik/ }).first()).toBeVisible()
  await expect(page.getByText('Points d\'entrée').first()).toBeVisible()
  await page.getByPlaceholder('Domaine, conteneur, stack, réseau…').fill('zzz-introuvable')
  await expect(page.getByText('Aucune route ne correspond au filtre')).toBeVisible()

  // Pré-remplissage : formulaire rempli et justifié, rien n'est enregistré.
  await page.getByRole('button', { name: /Reprendre dans la configuration Traefik/ }).click()
  await expect(page.getByText('Valeurs reprises de l\'existant', { exact: true })).toBeVisible()
  await expect(page.getByLabel('Réseau Traefik')).not.toHaveValue('')
})

test('reprise de l\'existant : inventaire et aperçu, sans création', async ({ page, request }) => {
  const ep = await agentEndpoint(request)
  await page.goto(`/servers/${ep!.serverId}?tab=adopt&endpoint=${ep!.endpointId}`)
  const row = page.getByRole('row').filter({ has: page.getByRole('button', { name: 'Reprendre' }) }).first()
  await expect(row).toBeVisible({ timeout: 20_000 })
  await row.getByRole('button', { name: 'Reprendre' }).click()
  await page.getByRole('button', { name: 'Analyser la stack' }).click()
  await expect(page.getByRole('heading', { name: 'Premier déploiement géré' })).toBeVisible({ timeout: 30_000 })
  await expect(page.getByRole('button', { name: 'Reprendre en projet' })).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(page.getByRole('dialog')).toHaveCount(0)
})

test('reprise depuis les projets : choix d\'une stack d\'un serveur, assistant ouvert sur elle, sans création', async ({ page }) => {
  await page.goto('/projects')
  await page.getByRole('button', { name: 'Reprendre une stack' }).click()
  const picker = page.getByRole('dialog', { name: 'Reprendre une stack existante' })
  const item = picker.getByRole('listitem').filter({ has: page.getByRole('button', { name: 'Reprendre' }) }).first()
  await expect(item).toBeVisible({ timeout: 30_000 })
  // Le Traefik géré par la plateforme n'est jamais proposé.
  await expect(picker.getByText('platform-traefik', { exact: true })).toHaveCount(0)
  const stack = (await item.locator('strong').first().innerText()).trim()
  await item.getByRole('button', { name: 'Reprendre' }).click()
  await expect(page).toHaveURL(/tab=adopt/)
  await expect(page.getByRole('dialog', { name: `Reprendre « ${stack} »` })).toBeVisible({ timeout: 30_000 })
  await expect(page.getByRole('button', { name: 'Analyser la stack' })).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(page.getByRole('dialog')).toHaveCount(0)
})

test('reprise : assistant de levée des points bloquants, ports justifiés sans écrire de règle', async ({ page, request }) => {
  const ep = await agentEndpoint(request)
  const stacks = await (await request.get(`/api/endpoints/${ep.endpointId}/adoptable`)).json() as { name: string, managedBy: unknown, infrastructure: string | null }[]
  const candidates = stacks.filter(s => !s.managedBy && !s.infrastructure)
  test.skip(!candidates.length, 'Aucune stack externe à reprendre sur l\'hôte de test')
  let found = false
  for (const s of candidates) {
    await page.goto(`/servers/${ep.serverId}?tab=adopt&endpoint=${ep.endpointId}&stack=${encodeURIComponent(s.name)}`)
    await page.getByRole('button', { name: 'Analyser la stack' }).click()
    await expect(page.getByRole('button', { name: 'Reprendre en projet' })).toBeVisible({ timeout: 60_000 })
    const fix = page.getByRole('button', { name: /^Lever les \d+ points? bloquants?$/ })
    if (await fix.isVisible() && await page.getByText(/Port custom : justification requise/).first().isVisible()) {
      found = true
      const before = Number((await fix.innerText()).match(/\d+/)![0])
      await fix.click()
      const wiz = page.getByRole('dialog', { name: /Lever les points bloquants/ })
      // Aller au premier port à justifier, tout justifier d'un coup.
      // Port à garder : choix explicite (une publication web propose d'abord le reverse proxy).
      for (let i = 0; i < 20; i++) {
        const keep = wiz.getByRole('radio', { name: /Garder le port et le justifier/ })
        if (await keep.isVisible()) {
          await keep.check()
          break
        }
        await wiz.getByRole('button', { name: 'Passer' }).click()
      }
      const all = wiz.getByRole('checkbox', { name: /Même justification/ })
      if (await all.isVisible()) await all.check()
      await wiz.getByRole('checkbox', { name: /Je confirme la publication/ }).check()
      await wiz.getByRole('button', { name: 'Justifier et continuer' }).click()
      while (await wiz.isVisible()) {
        const end = wiz.getByRole('button', { name: 'Terminer et réanalyser' })
        if (await end.isVisible()) await end.click()
        else await wiz.getByRole('button', { name: 'Passer' }).click()
      }
      await expect(page.getByText(/port\(s\) justifié\(s\)/)).toBeVisible({ timeout: 60_000 })
      await expect(page.getByText(/Port custom : justification requise/)).toHaveCount(0, { timeout: 60_000 })
      const after = page.getByRole('button', { name: /^Lever les \d+ points? bloquants?$/ })
      if (await after.isVisible()) expect(Number((await after.innerText()).match(/\d+/)![0])).toBeLessThan(before)
      break
    }
  }
  test.skip(!found, 'Aucune stack avec un port à justifier')
  await page.keyboard.press('Escape')
})

test('rebrancher derrière Traefik : conteneur routé hors du réseau du proxy, réparé, puis joignable', async ({ page, request }) => {
  test.setTimeout(180_000)
  const docker = (...args: string[]) => execFileSync('docker', args, { encoding: 'utf8' }).trim()
  const curl = (host: string) => { try { return execFileSync('curl', ['-sk', '-o', '-', '-w', '%{http_code}', '-H', `Host: ${host}`, 'https://127.0.0.1:28443/'], { encoding: 'utf8' }) } catch { return '' } }
  test.skip(!docker('ps', '--format', '{{.Names}}').split('\n').includes('platform-traefik-traefik-1'), 'Traefik de dev absent')
  const { csrfToken } = await (await request.get('/api/auth/me')).json() as { csrfToken: string }
  const servers = await (await request.get('/api/servers?pageSize=100')).json() as { items: { id: string, name: string }[] }
  const server = servers.items.find(s => s.name === 'agent-local')!
  const detail = await (await request.get(`/api/servers/${server.id}`)).json() as { endpoints: { id: string, enabled: boolean, environments: unknown[] }[] }
  const ep = detail.endpoints.find(e => e.enabled && e.environments.length)!
  const name = `reattach-${Date.now().toString(36)}`
  const host = `${name}.localhost`
  docker('run', '-d', '--name', name,
    '--label', 'platform.managed=true', '--label', 'traefik.enable=true', '--label', 'traefik.docker.network=platform-edge',
    '--label', `traefik.http.routers.${name}.rule=Host(\`${host}\`)`, '--label', `traefik.http.routers.${name}.entrypoints=websecure`, '--label', `traefik.http.routers.${name}.tls=true`,
    '--label', `traefik.http.services.${name}.loadbalancer.server.port=8080`,
    'busybox:1.37', 'sh', '-c', 'echo reattach-ok > /tmp/index.html && httpd -f -p 8080 -h /tmp')
  try {
    const routeOf = async () => ((await (await request.get(`/api/endpoints/${ep.id}/proxy-map?refresh=1`)).json()) as { topology: { routes: { container: { id: string, name: string } | null, reattach?: { network: string } | null }[] } })
      .topology.routes.find(r => r.container?.name === name)
    expect((await routeOf())?.reattach).toMatchObject({ network: 'platform-edge' })
    expect(curl(host)).not.toContain('reattach-ok')

    // Interface : bandeau et réparation.
    await page.goto(`/proxies?endpoint=${ep.id}`)
    await expect(page.getByText(new RegExp(`absent\\(s\\) de son réseau.*${name}`))).toBeVisible({ timeout: 30_000 })
    const started = docker('inspect', '-f', '{{.State.StartedAt}}', name)
    await page.getByRole('button', { name: 'Tout rebrancher' }).click()
    await page.getByRole('dialog').getByRole('button', { name: 'Rebrancher' }).click()
    await expect(page.getByText(/rebranché/).first()).toBeVisible({ timeout: 30_000 })

    expect(docker('inspect', '-f', '{{range $k,$v := .NetworkSettings.Networks}}{{$k}} {{end}}', name)).toContain('platform-edge')
    expect(docker('inspect', '-f', '{{.State.StartedAt}}', name)).not.toBe(started)
    await expect.poll(() => curl(host), { timeout: 30_000 }).toContain('reattach-ok')
    expect((await routeOf())?.reattach ?? null).toBeNull()
    // Réseau sans Traefik : refusé.
    expect((await request.post(`/api/endpoints/${ep.id}/proxy/reattach`, { data: { containerId: docker('inspect', '-f', '{{.Id}}', name), network: 'bridge' }, headers: { 'x-csrf-token': csrfToken } })).status()).toBe(422)
  }
  finally {
    docker('rm', '-f', name)
  }
})
