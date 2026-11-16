/**
 * Migration d'une stack entre deux serveurs gérés de l'infrastructure de dev : agent-local (Docker
 * Desktop, agent Portainer) → ssh-dev (son propre moteur Docker, joint en SSH).
 * - réussite : volume nommé et dossier des données copiés (contenu et propriétaires), stack
 *   démarrée sur la cible, ancienne stack arrêtée puis nettoyée depuis la page du projet ;
 * - échec sur la cible : stack retirée de la cible et redémarrée sur l'origine.
 */
import { execFileSync } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import type { APIRequestContext, Page } from '@playwright/test'
import { expect, test } from './fixtures'

const docker = (...args: string[]) => execFileSync('docker', args, { encoding: 'utf8' }).trim()
const onSsh = (...args: string[]) => docker('exec', 'sherpa-dev-ssh-host-1', 'docker', ...args)

interface Setup { headers: Record<string, string>, origin: { id: string }, dest: { id: string, environments: { key: string }[] }, env: string }

async function setup(request: APIRequestContext): Promise<Setup | null> {
  const { csrfToken } = await (await request.get('/api/auth/me')).json() as { csrfToken: string }
  const headers = { 'x-csrf-token': csrfToken }
  const servers = await (await request.get('/api/servers?pageSize=100')).json() as { items: { id: string, name: string }[] }
  const a = servers.items.find(s => s.name === 'agent-local')
  const b = servers.items.find(s => s.name === 'ssh-dev')
  if (!a || !b) return null
  type Detail = { endpoints: { id: string, enabled: boolean, environments: { key: string }[] }[] }
  const origin = (await (await request.get(`/api/servers/${a.id}`)).json() as Detail).endpoints.find(e => e.enabled && e.environments.length)!
  const dest = (await (await request.get(`/api/servers/${b.id}`)).json() as Detail).endpoints.find(e => e.enabled)!
  const env = origin.environments[0]!.key
  // La cible accepte l'environnement de l'origine le temps du test, avec ses chemins.
  if (!dest.environments.some(e => e.key === env)) {
    const r = await request.patch(`/api/endpoints/${dest.id}`, { data: { environmentKeys: [...dest.environments.map(e => e.key), env] }, headers })
    expect(r.status(), await r.text()).toBe(200)
  }
  const paths = await request.put(`/api/endpoints/${dest.id}/paths/${env}`, { data: { workingRoot: `/srv/apps/deployments/${env}`, buildRoot: `/srv/apps/build/${env}`, tmpRoot: `/srv/apps/tmp/${env}`, runtimeRoot: `/srv/apps/data/${env}`, minFreeDiskMb: 64 }, headers })
  expect(paths.status(), await paths.text()).toBe(200)
  return { headers, origin, dest, env }
}

async function deployOnOrigin(page: Page, projectId: string, compose: string) {
  await page.goto(`/projects/${projectId}`)
  await expect(async () => {
    await page.getByRole('button', { name: 'Nouveau déploiement' }).click({ timeout: 5000 })
    await expect(page.getByRole('textbox', { name: 'Contenu du fichier Compose' })).toBeVisible({ timeout: 3000 })
  }).toPass({ timeout: 30_000 })
  await page.getByRole('textbox', { name: 'Contenu du fichier Compose' }).fill(compose)
  await page.getByRole('button', { name: 'Analyser ce Compose' }).click({ timeout: 10_000 })
  await page.getByRole('button', { name: 'Déployer', exact: true }).click({ timeout: 60_000 })
  await page.getByRole('dialog').getByRole('button', { name: 'Déployer' }).click({ timeout: 10_000 })
  await expect(page.getByRole('log')).toContainText('Statut : HEALTHY', { timeout: 300_000 })
}

async function migrate(page: Page, projectId: string, stack: string, uncheck: string[] = []) {
  await page.goto(`/projects/${projectId}`)
  await page.getByRole('button', { name: 'Migrer…' }).click()
  const dialog = page.getByRole('dialog')
  await expect(dialog.getByLabel('Serveur de destination')).toHaveValue(/.+/)
  await expect(dialog.getByText('Données copiées')).toBeVisible({ timeout: 120_000 })
  await expect(dialog.getByLabel('Empêchements')).toHaveCount(0)
  for (const label of uncheck) await dialog.getByRole('checkbox', { name: label }).uncheck()
  await dialog.getByLabel(`Saisir le nom de la stack (${stack}) pour confirmer`).fill(stack)
  await dialog.getByRole('button', { name: /^Migrer vers ssh-dev/ }).click()
  await page.waitForURL(/\/deployments\//, { timeout: 60_000 })
}

test.describe.serial('migration entre serveurs', () => {
  test('stack et données migrées vers ssh-dev, ancienne stack nettoyée', async ({ page, request }) => {
    test.setTimeout(900_000)
    const s = await setup(request)
    test.skip(!s, 'serveurs agent-local et ssh-dev requis')
    const { headers, env } = s!
    const slug = `mig-${Date.now().toString(36)}`
    const stack = `${slug}-${env}`
    const { id } = await (await request.post('/api/projects', { data: { slug, name: `Migration ${slug}`, target: { endpointId: s!.origin.id, environmentKey: env } }, headers })).json() as { id: string }
    try {
      await deployOnOrigin(page, id, 'services:\n  app:\n    image: busybox:1.37\n    command: ["sleep", "3600"]\n    volumes:\n      - data:/data\n      - ./files:/files\nvolumes:\n  data: {}\n')
      docker('exec', `${stack}-app-1`, 'sh', '-c', 'echo bonjour > /data/a.txt && chown 1234:4321 /data/a.txt && mkdir -p /files/sous && echo monde > /files/sous/b.txt && dd if=/dev/urandom of=/data/gros bs=1M count=8 2>/dev/null')
      const sum = docker('exec', `${stack}-app-1`, 'md5sum', '/data/gros').split(' ')[0]

      await migrate(page, id, stack)
      await expect(page.getByRole('log')).toContainText(/Statut : (HEALTHY|FAILED|ROLLED_BACK)/, { timeout: 600_000 })
      await expect(page.getByRole('log')).toContainText('Statut : HEALTHY')
      await expect(page.getByRole('log')).toContainText(`Volume ${stack}_data copié`)

      // Sur la cible : mêmes données, mêmes propriétaires.
      expect(onSsh('exec', `${stack}-app-1`, 'cat', '/data/a.txt')).toBe('bonjour')
      expect(onSsh('exec', `${stack}-app-1`, 'stat', '-c', '%u:%g', '/data/a.txt')).toBe('1234:4321')
      expect(onSsh('exec', `${stack}-app-1`, 'cat', '/files/sous/b.txt')).toBe('monde')
      expect(onSsh('exec', `${stack}-app-1`, 'md5sum', '/data/gros').split(' ')[0]).toBe(sum)
      // Sur l'origine : arrêtée, conservée.
      expect(docker('inspect', '-f', '{{.State.Running}}', `${stack}-app-1`)).toBe('false')

      // Page du projet : la cible est sur ssh-dev ; nettoyage de l'ancienne stack et de ses données.
      await page.goto(`/projects/${id}`)
      await expect(page.getByText(/Migrée depuis agent-local/)).toBeVisible()
      await expect(page.locator('.target.on')).toContainText('ssh-dev')
      await page.getByRole('button', { name: 'Supprimer l\'ancienne stack…' }).click()
      const dialog = page.getByRole('dialog')
      await dialog.getByRole('checkbox', { name: /Supprimer aussi les données d'origine/ }).check()
      await dialog.getByLabel(`Saisir le nom de la stack (${stack}) pour confirmer`).fill(stack)
      await dialog.getByRole('button', { name: 'Supprimer' }).click()
      await expect(page.getByText(/Ancienne stack supprimée/)).toBeVisible({ timeout: 120_000 })
      await expect(page.getByText(/Migrée depuis agent-local/)).toHaveCount(0)
      expect(docker('ps', '-a', '--filter', `label=com.docker.compose.project=${stack}`, '--format', '{{.Names}}')).toBe('')
      expect(docker('volume', 'ls', '-q', '--filter', `name=${stack}_data`)).toBe('')
    }
    finally {
      await request.post(`/api/projects/${id}/removal`, { data: { mode: 'delete', confirm: slug }, headers }).catch(() => null)
      await expect(async () => expect(onSsh('ps', '-a', '--filter', `label=com.docker.compose.project=${stack}`, '--format', '{{.Names}}')).toBe('')).toPass({ timeout: 120_000 }).catch(() => {})
      // Restes éventuels (test interrompu) : sans effet sinon.
      for (const cmd of [['rm', '-f', `${stack}-app-1`], ['volume', 'rm', '-f', `${stack}_data`]]) {
        for (const run of [docker, onSsh]) {
          try {
            run(...cmd)
          }
          catch {
            // Déjà supprimé.
          }
        }
      }
    }
  })

  test('échec sur la cible : stack retirée de la cible et redémarrée sur l\'origine', async ({ page, request }) => {
    test.setTimeout(900_000)
    const s = await setup(request)
    test.skip(!s, 'serveurs agent-local et ssh-dev requis')
    const { headers, env } = s!
    const slug = `migko-${Date.now().toString(36)}`
    const stack = `${slug}-${env}`
    const { id } = await (await request.post('/api/projects', { data: { slug, name: `Migration KO ${slug}`, target: { endpointId: s!.origin.id, environmentKey: env } }, headers })).json() as { id: string }
    try {
      // Le service exige un fichier de son dossier de données ; les données ne sont pas copiées : en échec sur la cible.
      const cfg = await (await request.get(`/api/endpoints/${s!.origin.id}/config`)).json() as { paths: Record<string, { runtimeRoot: string }> }
      const runtimeRoot = cfg.paths[env]!.runtimeRoot
      mkdirSync(`${runtimeRoot}/${slug}/files`, { recursive: true })
      writeFileSync(`${runtimeRoot}/${slug}/files/ok`, 'ok')
      await deployOnOrigin(page, id, 'services:\n  app:\n    image: busybox:1.37\n    command: ["sleep", "3600"]\n    volumes:\n      - ./files:/files\n    healthcheck:\n      test: ["CMD", "test", "-f", "/files/ok"]\n      interval: 2s\n      timeout: 3s\n      retries: 2\n')
      await request.patch(`/api/targets/${((await (await request.get(`/api/projects/${id}`)).json()) as { targets: { id: string }[] }).targets[0]!.id}`, { data: { healthTimeoutSec: 30 }, headers })
      await migrate(page, id, stack, ['Copier Données du projet'])
      await expect(page.getByRole('log')).toContainText(/Statut : (HEALTHY|FAILED|ROLLED_BACK)/, { timeout: 600_000 })
      await expect(page.getByRole('log')).toContainText('Statut : ROLLED_BACK')
      await expect(page.getByRole('log')).toContainText(`Stack ${stack} redémarrée sur agent-local`)
      expect(docker('inspect', '-f', '{{.State.Running}}', `${stack}-app-1`)).toBe('true')
      expect(onSsh('ps', '-a', '--filter', `label=com.docker.compose.project=${stack}`, '--format', '{{.Names}}')).toBe('')
      await page.goto(`/projects/${id}`)
      await expect(page.locator('.target.on')).toContainText('agent-local')
      await expect(page.getByText(/Migrée depuis/)).toHaveCount(0)
    }
    finally {
      await request.post(`/api/projects/${id}/removal`, { data: { mode: 'delete', confirm: slug }, headers }).catch(() => null)
    }
  })
})
