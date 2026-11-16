/**
 * Migration PostgreSQL 16 → 18 de bout en bout, sur l'infrastructure de dev (serveur agent-local) :
 * projet jetable déployé depuis l'interface, données et rôle ajoutés, migration par l'API,
 * contrôle des données sur la nouvelle version, puis suppression du projet et de son volume.
 */
import { execFileSync } from 'node:child_process'
import { expect, test } from './fixtures'

const docker = (...args: string[]) => execFileSync('docker', args, { encoding: 'utf8' }).trim()
const COMPOSE = `services:
  db:
    image: postgres:16-alpine
    environment:
      POSTGRES_USER: app
      POSTGRES_PASSWORD: e2e-secret
      POSTGRES_DB: edutis
    volumes:
      - data:/var/lib/postgresql/data
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U app -d edutis"]
      interval: 3s
      retries: 20
volumes:
  data: {}
`

test('migration PostgreSQL 16 → 18 : sauvegarde, restauration, données et rôles conservés', async ({ page, request }) => {
  test.setTimeout(900_000)
  const { csrfToken } = await (await request.get('/api/auth/me')).json() as { csrfToken: string }
  const headers = { 'x-csrf-token': csrfToken }
  const servers = await (await request.get('/api/servers?pageSize=100')).json() as { items: { id: string, name: string }[] }
  const server = servers.items.find(s => s.name === 'agent-local')
  test.skip(!server, 'serveur agent-local absent')
  const detail = await (await request.get(`/api/servers/${server!.id}`)).json() as { endpoints: { id: string, enabled: boolean, environments: { key: string }[] }[] }
  const ep = detail.endpoints.find(e => e.enabled && e.environments.length)!
  const env = ep.environments[0]!.key
  const slug = `pgmig-${Date.now().toString(36)}`
  const created = await request.post('/api/projects', { data: { slug, name: `Migration PG ${slug}`, target: { endpointId: ep.id, environmentKey: env } }, headers })
  expect(created.status(), await created.text()).toBe(201)
  const project = await created.json() as { id: string }
  const stack = `${slug}-${env}`
  const container = `${stack}-db-1`
  try {
    // 1. Déploiement de PostgreSQL 16 depuis l'interface.
    await page.goto(`/projects/${project.id}`)
    await page.getByRole('button', { name: 'Nouveau déploiement' }).click({ timeout: 30_000 })
    // Source par défaut : « Compose saisi ».
    await page.getByRole('textbox', { name: 'Contenu du fichier Compose' }).fill(COMPOSE, { timeout: 10_000 })
    await page.getByRole('button', { name: 'Analyser ce Compose' }).click({ timeout: 10_000 })
    await expect(page.getByRole('heading', { name: /Analyse/ })).toBeVisible({ timeout: 60_000 })
    await page.getByRole('button', { name: 'Déployer', exact: true }).click({ timeout: 30_000 })
    await page.getByRole('dialog').getByRole('button', { name: 'Déployer' }).click({ timeout: 10_000 })
    await expect(page).toHaveURL(/\/deployments\/[0-9a-f-]{36}$/)
    await expect(page.getByRole('log')).toContainText('Statut : HEALTHY', { timeout: 300_000 })

    // 2. Données et rôle applicatif.
    docker('exec', container, 'psql', '-U', 'app', '-d', 'edutis', '-qc', 'create table t(id int primary key, v text); insert into t select g, md5(g::text) from generate_series(1,5000) g; create role lecteur login password \'x\'; grant select on t to lecteur;')

    // 3. Plan puis migration vers la 18.
    const targets = await (await request.get(`/api/projects/${project.id}`)).json() as { targets: { id: string }[] }
    const targetId = targets.targets[0]!.id
    const plan = await (await request.get(`/api/targets/${targetId}/pg-migration?service=db`)).json() as { blockers: string[], candidates: { major: number, tag: string }[], mount: { destination: string } | null }
    expect(plan.blockers).toEqual([])
    expect(plan.mount?.destination).toBe('/var/lib/postgresql/data')
    const to18 = plan.candidates.find(c => c.major === 18)
    expect(to18, JSON.stringify(plan.candidates)).toBeTruthy()
    const started = await request.post(`/api/targets/${targetId}/pg-migration`, { data: { service: 'db', tag: to18!.tag, confirm: 'db' }, headers })
    expect(started.status(), await started.text()).toBe(202)
    const { deploymentId } = await started.json() as { deploymentId: string }
    await page.goto(`/deployments/${deploymentId}`)
    await expect(page.getByRole('log')).toContainText('Restauration conforme', { timeout: 600_000 })
    await expect(page.getByRole('log')).toContainText(/Statut : (HEALTHY|FAILED|ROLLED_BACK)/, { timeout: 300_000 })
    await expect(page.getByRole('log')).toContainText('Statut : HEALTHY')

    // 4. Nouvelle version, nouvelles données, données et rôle conservés.
    expect(docker('exec', container, 'psql', '-U', 'app', '-d', 'edutis', '-tAc', 'show server_version_num')).toMatch(/^18/)
    expect(docker('exec', container, 'printenv', 'PGDATA')).toBe('/var/lib/postgresql/data/pg18')
    expect(docker('exec', container, 'psql', '-U', 'app', '-d', 'edutis', '-tAc', 'select count(*) from t')).toBe('5000')
    expect(docker('exec', '-e', 'PGPASSWORD=x', container, 'psql', '-h', '127.0.0.1', '-U', 'lecteur', '-d', 'edutis', '-tAc', 'select count(*) from t')).toBe('5000')

    // 5. Ancien cluster supprimé après validation : fichiers de la 16 retirés, la 18 intacte.
    expect(docker('exec', container, 'cat', '/var/lib/postgresql/data/PG_VERSION')).toBe('16')
    const refused = await request.post(`/api/targets/${targetId}/pg-migration/cleanup`, { data: { service: 'db', confirm: 'autre', removeBackup: true }, headers })
    expect(refused.status()).toBe(422)
    const cleaned = await request.post(`/api/targets/${targetId}/pg-migration/cleanup`, { data: { service: 'db', confirm: 'db', removeBackup: true }, headers })
    expect(cleaned.status(), await cleaned.text()).toBe(200)
    expect((await cleaned.json() as { backupRemoved: boolean }).backupRemoved).toBe(true)
    expect(docker('exec', container, 'ls', '-A', '/var/lib/postgresql/data')).toBe('pg18')
    expect(docker('exec', container, 'psql', '-U', 'app', '-d', 'edutis', '-tAc', 'select count(*) from t')).toBe('5000')
    const again = await request.post(`/api/targets/${targetId}/pg-migration/cleanup`, { data: { service: 'db', confirm: 'db' }, headers })
    expect(again.status()).toBe(409)
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
