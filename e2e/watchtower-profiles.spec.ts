/**
 * Watchtower par profil de serveur, sur l'infrastructure de dev (serveur agent-local) :
 * deux projets, un seul conteneur Watchtower ; pause d'un projet = ses conteneurs exclus, l'autre
 * continue ; rapport du profil attribué au bon projet ; conteneur supprimé : signalé puis réappliqué.
 */
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from './fixtures'

const docker = (...args: string[]) => execFileSync('docker', args, { encoding: 'utf8' }).trim()

/** Formulaire de déploiement ouvert (clic répété si la page n'était pas encore prête). */
async function openNewDeployment(page: import('@playwright/test').Page) {
  await expect(async () => {
    await page.getByRole('button', { name: 'Nouveau déploiement' }).click({ timeout: 5000 })
    await expect(page.getByRole('textbox', { name: 'Contenu du fichier Compose' })).toBeVisible({ timeout: 3000 })
  }).toPass({ timeout: 30_000 })
}

test('profils Watchtower : un conteneur partagé, pause par projet, rapport réparti, absence signalée', async ({ page, request }) => {
  test.setTimeout(900_000)
  const { csrfToken } = await (await request.get('/api/auth/me')).json() as { csrfToken: string }
  const headers = { 'x-csrf-token': csrfToken }
  const servers = await (await request.get('/api/servers?pageSize=100')).json() as { items: { id: string, name: string }[] }
  const server = servers.items.find(s => s.name === 'agent-local')
  test.skip(!server, 'serveur agent-local absent')
  const detail = await (await request.get(`/api/servers/${server!.id}`)).json() as { endpoints: { id: string, enabled: boolean, environments: { key: string }[] }[] }
  const ep = detail.endpoints.find(e => e.enabled && e.environments.length)!
  const env = ep.environments[0]!.key

  // Profil dédié au test.
  const pr = await request.post(`/api/endpoints/${ep.id}/watchtower-profiles`, { data: { name: `Test ${Date.now().toString(36)}`, timing: 'interval', intervalSec: 86_400 }, headers })
  expect(pr.status(), await pr.text()).toBe(201)
  const profile = await pr.json() as { id: string, scope: string }

  const projects: { id: string, slug: string, targetId: string, stack: string }[] = []
  try {
    for (const n of [1, 2]) {
      const slug = `wtp${n}-${Date.now().toString(36)}`
      const created = await request.post('/api/projects', { data: { slug, name: `Profil WT ${slug}`, target: { endpointId: ep.id, environmentKey: env } }, headers })
      expect(created.status(), await created.text()).toBe(201)
      const { id } = await created.json() as { id: string }
      const targetId = ((await (await request.get(`/api/projects/${id}`)).json()) as { targets: { id: string }[] }).targets[0]!.id
      projects.push({ id, slug, targetId, stack: `${slug}-${env}` })
      const cfg = await request.put(`/api/targets/${targetId}/watchtower`, { data: { enabled: true, mode: 'automatic', services: { app: 'update' }, profileId: profile.id }, headers })
      expect(cfg.status(), await cfg.text()).toBe(200)
      await page.goto(`/projects/${id}`)
      await openNewDeployment(page)
      await page.getByRole('textbox', { name: 'Contenu du fichier Compose' }).fill('services:\n  app:\n    image: busybox:1.37\n    command: ["sleep", "3600"]\n', { timeout: 10_000 })
      await page.getByRole('button', { name: 'Analyser ce Compose' }).click({ timeout: 10_000 })
      await expect(page.getByRole('heading', { name: /Analyse/ })).toBeVisible({ timeout: 60_000 })
      await page.getByRole('button', { name: 'Déployer', exact: true }).click({ timeout: 30_000 })
      await page.getByRole('dialog').getByRole('button', { name: 'Déployer' }).click({ timeout: 10_000 })
      await expect(page.getByRole('log')).toContainText('Statut : HEALTHY', { timeout: 300_000 })
      await expect(page.getByRole('log')).toContainText('Watchtower du profil')
    }
    const [a, b] = projects as [typeof projects[0], typeof projects[0]]

    // Un seul conteneur Watchtower pour le profil ; aucun dans les stacks des projets.
    const profileContainers = () => docker('ps', '-aq', '--filter', `label=platform.watchtower-profile=${profile.id}`).split('\n').filter(Boolean)
    expect(profileContainers()).toHaveLength(1)
    for (const p of projects) {
      expect(docker('ps', '-aq', '--filter', `label=com.docker.compose.project=${p.stack}`, '--filter', 'label=com.docker.compose.service=platform-watchtower')).toBe('')
      expect(docker('inspect', '-f', '{{index .Config.Labels "com.centurylinklabs.watchtower.scope"}}', `${p.stack}-app-1`)).toBe(profile.scope)
    }
    const list = await (await request.get(`/api/endpoints/${ep.id}/watchtower-profiles`)).json() as { id: string, runtime: { state: string }, projects: { targetId: string }[] }[]
    const mine = list.find(p => p.id === profile.id)!
    expect(mine.runtime.state).toBe('running')
    expect(mine.projects.map(p => p.targetId).sort()).toEqual([a.targetId, b.targetId].sort())

    // Pause du projet A : ses conteneurs exclus du Watchtower du profil, pas ceux de B.
    const wtName = () => docker('inspect', '-f', '{{.Name}}', profileContainers()[0]!).replace(/^\//, '')
    const disabled = () => docker('inspect', '-f', '{{range .Config.Env}}{{println .}}{{end}}', wtName()).split('\n').find(l => l.startsWith('WATCHTOWER_DISABLE_CONTAINERS='))?.split('=')[1] ?? ''
    expect((await request.post(`/api/targets/${a.targetId}/watchtower/pause`, { headers })).status()).toBe(200)
    expect(disabled()).toBe(`${a.stack}-app-1`)
    expect(profileContainers()).toHaveLength(1)
    expect((await request.post(`/api/targets/${a.targetId}/watchtower/resume`, { headers })).status()).toBe(200)
    expect(disabled()).toBe('')

    // Rapport du profil : attribué au projet dont le conteneur est cité.
    const hook = docker('inspect', '-f', '{{range .Config.Env}}{{println .}}{{end}}', wtName()).split('\n').find(l => l.startsWith('WATCHTOWER_NOTIFICATION_URL='))!.split('=').slice(1).join('=')
    const path = new URL(hook.replace(/^generic\+/, '')).pathname
    const report = { updated: [], failed: [], stale: [{ name: `/${b.stack}-app-1`, image: 'busybox:1.37', from: 'sha256:aaa', to: 'sha256:bbb' }] }
    expect((await request.post(path, { data: JSON.stringify(report), headers: { 'content-type': 'application/json' } })).status()).toBe(202)
    await expect.poll(async () => ((await (await request.get(`/api/targets/${b.targetId}/watchtower`)).json()) as { updates: { kind: string }[] }).updates.filter(u => u.kind === 'available').length, { timeout: 30_000 }).toBe(1)
    expect(((await (await request.get(`/api/targets/${a.targetId}/watchtower`)).json()) as { updates: { kind: string }[] }).updates.filter(u => u.kind === 'available')).toHaveLength(0)
    expect((await request.post(path.replace(/[^/]+$/, 'x'.repeat(43)), { data: '{}' })).status()).toBe(404)

    // Conteneur du profil supprimé hors console : signalé, puis réappliqué.
    docker('rm', '-f', wtName())
    expect(((await (await request.get(`/api/targets/${a.targetId}/watchtower`)).json()) as { runtime: { state: string } }).runtime.state).toBe('missing')
    expect((await request.post(`/api/watchtower-profiles/${profile.id}/apply`, { headers })).status()).toBe(200)
    expect(((await (await request.get(`/api/targets/${a.targetId}/watchtower`)).json()) as { runtime: { state: string } }).runtime.state).toBe('running')

    // Registres privés : config.json dans le conteneur du profil, jamais dans son environnement ni dans l'API.
    const base = { name: (await (await request.get(`/api/endpoints/${ep.id}/watchtower-profiles`)).json() as { id: string, name: string }[]).find(p => p.id === profile.id)!.name, timing: 'interval', intervalSec: 86_400 }
    const withReg = await request.put(`/api/watchtower-profiles/${profile.id}`, { data: { ...base, registries: [{ registry: 'harbor.e2e.test', username: 'robot', password: 'pw-e2e-123' }] }, headers })
    expect(withReg.status(), await withReg.text()).toBe(200)
    expect(JSON.stringify(await withReg.json())).not.toContain('pw-e2e-123')
    expect(((await withReg.json()) as { registries: unknown[], pending: boolean })).toMatchObject({ registries: [{ registry: 'harbor.e2e.test', username: 'robot', hasPassword: true }], pending: true })
    expect((await request.post(`/api/watchtower-profiles/${profile.id}/apply`, { headers })).status()).toBe(200)
    // Image Watchtower sans shell : fichier lu par docker cp.
    const readCfg = () => {
      const out = join(mkdtempSync(join(tmpdir(), 'wtcfg-')), 'config.json')
      docker('cp', `${wtName()}:/config.json`, out)
      return readFileSync(out, 'utf8')
    }
    const cfg = JSON.parse(readCfg()) as { auths: Record<string, { auth: string }> }
    expect(Buffer.from(cfg.auths['harbor.e2e.test']!.auth, 'base64').toString()).toBe('robot:pw-e2e-123')
    expect(docker('inspect', '-f', '{{range .Config.Env}}{{println .}}{{end}}', wtName())).not.toContain('pw-e2e-123')
    // Modification sans mot de passe : conservé ; registre retiré : plus de config.json.
    const kept = await request.put(`/api/watchtower-profiles/${profile.id}`, { data: { ...base, registries: [{ registry: 'harbor.e2e.test', username: 'robot' }] }, headers })
    expect(((await kept.json()) as { pending: boolean }).pending).toBe(false)
    expect((await request.put(`/api/watchtower-profiles/${profile.id}`, { data: { ...base, registries: [{ registry: 'other.e2e.test', username: 'x' }] }, headers })).status()).toBe(422)
    await request.put(`/api/watchtower-profiles/${profile.id}`, { data: { ...base, registries: [] }, headers })
    expect((await request.post(`/api/watchtower-profiles/${profile.id}/apply`, { headers })).status()).toBe(200)
    expect(() => readCfg()).toThrow()

    // Fiche serveur : onglet Watchtower.
    await page.goto(`/servers/${server!.id}?tab=watchtower&endpoint=${ep.id}`)
    await expect(page.getByRole('heading', { name: 'Profils Watchtower' })).toBeVisible()
    await expect(page.getByText(profile.scope, { exact: true })).toBeVisible({ timeout: 20_000 })

    // Profil utilisé : suppression refusée.
    expect((await request.delete(`/api/watchtower-profiles/${profile.id}`, { headers })).status()).toBe(409)
  }
  finally {
    for (const p of projects) await request.post(`/api/projects/${p.id}/removal`, { data: { mode: 'delete', confirm: p.slug }, headers }).catch(() => null)
    for (let i = 0; i < 30; i++) {
      const r = await request.delete(`/api/watchtower-profiles/${profile.id}`, { headers }).catch(() => null)
      if (r && r.status() !== 409) break
      await new Promise(res => setTimeout(res, 3000))
    }
  }
})

test('reprise de l\'existant : projet sans profil, profil du serveur créé à son rythme', async ({ page, request }) => {
  test.setTimeout(600_000)
  const { csrfToken } = await (await request.get('/api/auth/me')).json() as { csrfToken: string }
  const headers = { 'x-csrf-token': csrfToken }
  const servers = await (await request.get('/api/servers?pageSize=100')).json() as { items: { id: string, name: string }[] }
  const server = servers.items.find(s => s.name === 'agent-local')
  test.skip(!server, 'serveur agent-local absent')
  const detail = await (await request.get(`/api/servers/${server!.id}`)).json() as { endpoints: { id: string, enabled: boolean, environments: { key: string }[] }[] }
  const ep = detail.endpoints.find(e => e.enabled && e.environments.length)!
  const env = ep.environments[0]!.key
  const schedule = `0 ${Math.floor(Math.random() * 59)} 2 * * *`
  const slug = `wtl-${Date.now().toString(36)}`
  const created = await request.post('/api/projects', { data: { slug, name: `Reprise WT ${slug}`, target: { endpointId: ep.id, environmentKey: env } }, headers })
  const { id } = await created.json() as { id: string }
  const targetId = ((await (await request.get(`/api/projects/${id}`)).json()) as { targets: { id: string }[] }).targets[0]!.id
  let profileId: string | null = null
  try {
    // Ancienne configuration par projet : rythme propre, aucun profil choisi.
    expect((await request.put(`/api/targets/${targetId}/watchtower`, { data: { enabled: true, mode: 'scheduled', schedule, services: { app: 'monitor' } }, headers })).status()).toBe(200)
    await page.goto(`/projects/${id}`)
    await openNewDeployment(page)
    await page.getByRole('textbox', { name: 'Contenu du fichier Compose' }).fill('services:\n  app:\n    image: busybox:1.37\n    command: ["sleep", "3600"]\n', { timeout: 10_000 })
    await page.getByRole('button', { name: 'Analyser ce Compose' }).click({ timeout: 10_000 })
    await expect(page.getByRole('heading', { name: /Analyse/ })).toBeVisible({ timeout: 60_000 })
    await page.getByRole('button', { name: 'Déployer', exact: true }).click({ timeout: 30_000 })
    await page.getByRole('dialog').getByRole('button', { name: 'Déployer' }).click({ timeout: 10_000 })
    await expect(page.getByRole('log')).toContainText('Statut : HEALTHY', { timeout: 300_000 })

    const wt = await (await request.get(`/api/targets/${targetId}/watchtower`)).json() as { profile: { id: string, name: string } | null, runtime: { state: string } }
    expect(wt.profile?.name).toBe(`Planifié (${schedule})`)
    expect(wt.runtime.state).toBe('running')
    profileId = wt.profile!.id
    const profiles = await (await request.get(`/api/endpoints/${ep.id}/watchtower-profiles`)).json() as { id: string, timing: string, schedule: string }[]
    expect(profiles.find(p => p.id === profileId)).toMatchObject({ timing: 'schedule', schedule })
  }
  finally {
    await request.post(`/api/projects/${id}/removal`, { data: { mode: 'delete', confirm: slug }, headers }).catch(() => null)
    for (let i = 0; profileId && i < 30; i++) {
      const r = await request.delete(`/api/watchtower-profiles/${profileId}`, { headers }).catch(() => null)
      if (r && r.status() !== 409) break
      await new Promise(res => setTimeout(res, 3000))
    }
  }
})
