/**
 * Migration PostgreSQL 14 → 17 avec les images d'Immich (VectorChord préchargé par la commande de
 * l'image) : sans les bibliothèques préchargées, pg_dump échouait sur l'index vectoriel
 * (« vchord must be loaded via shared_preload_libraries »). Données et index conservés.
 */
import { execFileSync } from 'node:child_process'
import { expect, test } from './fixtures'

const docker = (...args: string[]) => execFileSync('docker', args, { encoding: 'utf8' }).trim()
const FROM = 'ghcr.io/immich-app/postgres:14-vectorchord0.4.3-pgvectors0.2.0'
const COMPOSE = `services:
  database:
    image: ${FROM}
    environment:
      POSTGRES_USER: postgres
      POSTGRES_PASSWORD: e2e-secret
      POSTGRES_DB: immich
      POSTGRES_INITDB_ARGS: '--data-checksums'
    volumes:
      - data:/var/lib/postgresql/data
    shm_size: 128mb
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U postgres -d immich"]
      interval: 3s
      retries: 40
volumes:
  data: {}
`

test('migration PostgreSQL d\'Immich 14 → 17 : VectorChord préchargé, index vectoriel conservé', async ({ page, request }) => {
  test.setTimeout(1_800_000)
  const { csrfToken } = await (await request.get('/api/auth/me')).json() as { csrfToken: string }
  const headers = { 'x-csrf-token': csrfToken }
  const servers = await (await request.get('/api/servers?pageSize=100')).json() as { items: { id: string, name: string }[] }
  const server = servers.items.find(s => s.name === 'agent-local')
  test.skip(!server, 'serveur agent-local absent')
  try {
    docker('pull', FROM)
  }
  catch {
    test.skip(true, 'image d\'Immich indisponible (registre injoignable)')
  }
  const detail = await (await request.get(`/api/servers/${server!.id}`)).json() as { endpoints: { id: string, enabled: boolean, environments: { key: string }[] }[] }
  const ep = detail.endpoints.find(e => e.enabled && e.environments.length)!
  const env = ep.environments[0]!.key
  const slug = `immich-${Date.now().toString(36)}`
  const project = await (await request.post('/api/projects', { data: { slug, name: `Immich ${slug}`, target: { endpointId: ep.id, environmentKey: env } }, headers })).json() as { id: string }
  const container = `${slug}-${env}-database-1`
  const sql = (q: string) => docker('exec', container, 'psql', '-U', 'postgres', '-d', 'immich', '-tAc', q)
  try {
    await page.goto(`/projects/${project.id}`)
    await page.getByRole('button', { name: 'Nouveau déploiement' }).click({ timeout: 30_000 })
    await page.getByRole('textbox', { name: 'Contenu du fichier Compose' }).fill(COMPOSE, { timeout: 10_000 })
    await page.getByRole('button', { name: 'Analyser ce Compose' }).click({ timeout: 10_000 })
    await page.getByRole('button', { name: 'Déployer', exact: true }).click({ timeout: 60_000 })
    await page.getByRole('dialog').getByRole('button', { name: 'Déployer' }).click({ timeout: 10_000 })
    await expect(page.getByRole('log')).toContainText('Statut : HEALTHY', { timeout: 600_000 })

    // Comme Immich : extension VectorChord et index vectoriel.
    sql('create extension if not exists vchord cascade')
    sql('create table smart_search(id int primary key, embedding vector(3)); insert into smart_search select g, array[random(), random(), random()]::vector from generate_series(1, 2000) g; create index clip_index on smart_search using vchordrq (embedding vector_cosine_ops)')

    const targetId = ((await (await request.get(`/api/projects/${project.id}`)).json()) as { targets: { id: string }[] }).targets[0]!.id
    const plan = await (await request.get(`/api/targets/${targetId}/pg-migration?service=database`)).json() as { blockers: string[], candidates: { major: number, tag: string }[] }
    expect(plan.blockers).toEqual([])
    const to17 = plan.candidates.find(c => c.major === 17)
    test.skip(!to17, `aucune image 17 publiée : ${JSON.stringify(plan.candidates)}`)
    const started = await request.post(`/api/targets/${targetId}/pg-migration`, { data: { service: 'database', tag: to17!.tag, confirm: 'database' }, headers })
    expect(started.status(), await started.text()).toBe(202)
    await page.goto(`/deployments/${(await started.json() as { deploymentId: string }).deploymentId}`)
    await expect(page.getByRole('log')).toContainText('Bibliothèques préchargées', { timeout: 300_000 })
    await expect(page.getByRole('log')).toContainText(/Statut : (HEALTHY|FAILED|ROLLED_BACK)/, { timeout: 1_200_000 })
    await expect(page.getByRole('log')).toContainText('Restauration conforme')
    await expect(page.getByRole('log')).toContainText('Statut : HEALTHY')

    expect(sql('show server_version_num')).toMatch(/^17/)
    expect(sql('select count(*) from smart_search')).toBe('2000')
    expect(sql('select indexdef from pg_indexes where indexname = \'clip_index\'')).toContain('vchordrq')
    expect(sql('select id from smart_search order by embedding <=> \'[1,0,0]\' limit 1')).toMatch(/^\d+$/)
  }
  finally {
    await request.post(`/api/projects/${project.id}/removal`, { data: { mode: 'delete', confirm: slug }, headers }).catch(() => null)
    try {
      docker('volume', 'rm', '-f', `${slug}-${env}_data`)
    }
    catch {
      // Déjà supprimé.
    }
  }
})
