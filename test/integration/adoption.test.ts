/** Reprise de l'existant : inventaire, aperçu, création du projet, valeurs jamais exposées, garde-fous. */
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { databaseAvailable, setupTestDatabase } from '../helpers/db'

const available = await databaseAvailable()
const SECRET = 'valeur-tres-secrete-42'

vi.mock('../../server/adapters/portainer', async (orig) => {
  const real = await orig<typeof import('../../server/adapters/portainer')>()
  const traefikLabels = { 'com.docker.compose.project': 'edge', 'com.docker.compose.service': 'traefik' }
  const fake = {
    listContainers: async () => [
      { id: 'tr', names: ['edge-traefik-1'], image: 'traefik:v3.5', state: 'running', status: 'Up', labels: traefikLabels, networks: ['edge'], createdAt: '', ports: [{ ip: '0.0.0.0', privatePort: 443, publicPort: 443, type: 'tcp' }, { ip: '0.0.0.0', privatePort: 80, publicPort: 80, type: 'tcp' }], mounts: [] },
      {
        id: 'web', names: ['shop-web-1'], image: 'shop-web:latest', state: 'running', status: 'Up', networks: ['edge', 'shop_default'], createdAt: '',
        ports: [{ ip: null, privatePort: 3000, publicPort: null, type: 'tcp' }],
        mounts: [{ type: 'bind', source: '/data/compose/7/uploads', destination: '/app/uploads', rw: true, name: null }],
        labels: {
          'com.docker.compose.project': 'shop', 'com.docker.compose.service': 'web', 'traefik.enable': 'true',
          'traefik.http.routers.shop.rule': 'Host(`shop.example.org`)',
          'traefik.http.routers.shop-admin.rule': 'Host(`admin.example.org`) && Headers(`X-Admin`, `1`)',
        },
      },
      { id: 'leg', names: ['legacy-app-1'], image: 'nginx:1.27', state: 'running', status: 'Up', networks: ['legacy_default'], createdAt: '', ports: [], mounts: [], labels: { 'com.docker.compose.project': 'legacy', 'com.docker.compose.service': 'app', 'com.docker.compose.project.config_files': '/srv/legacy/compose.yml' } },
    ],
    inspectConfig: async (_c: unknown, _e: unknown, id: string) => (id === 'web'
      ? { id, name: 'shop-web-1', image: 'shop-web:latest', imageId: 'w', state: 'running', entrypoint: null, cmd: null, workingDir: null, user: null, env: ['PATH=/usr/bin', `API_KEY=${SECRET}`], labels: { 'com.docker.compose.project': 'shop', 'com.docker.compose.service': 'web', 'traefik.enable': 'true', 'traefik.http.routers.shop.rule': 'Host(`shop.example.org`)', 'traefik.http.routers.shop-admin.rule': 'Host(`admin.example.org`) && Headers(`X-Admin`, `1`)' }, healthcheck: null, restartPolicy: 'unless-stopped', privileged: false, capAdd: [], capDrop: [], networkMode: 'shop_default', portBindings: [], exposedPorts: ['3000/tcp'], mounts: [{ type: 'bind', source: '/data/compose/7/uploads', destination: '/app/uploads', rw: true, name: null }], networks: [{ name: 'edge', aliases: [] }, { name: 'shop_default', aliases: ['web'] }], extraHosts: [], stopSignal: null, tty: false }
      : id === 'tr'
      ? { id, name: 'edge-traefik-1', image: 'traefik:v3.5', imageId: 'x', state: 'running', entrypoint: ['/entrypoint.sh'], cmd: ['--providers.docker.exposedbydefault=false', '--providers.docker.network=edge', '--entrypoints.web.address=:80', '--entrypoints.web.http.redirections.entrypoint.to=websecure', '--entrypoints.websecure.address=:443', '--entrypoints.websecure.http.tls.certresolver=le', '--certificatesresolvers.le.acme.tlschallenge=true', '--providers.docker=true'], workingDir: null, user: null, env: [], labels: traefikLabels, healthcheck: null, restartPolicy: null, privileged: false, capAdd: [], capDrop: [], networkMode: null, portBindings: [], exposedPorts: [], mounts: [], networks: [], extraHosts: [], stopSignal: null, tty: false }
      : { id, name: 'legacy-app-1', image: 'nginx:1.27', imageId: 'y', state: 'running', entrypoint: null, cmd: null, workingDir: null, user: null, env: ['PATH=/usr/bin', `TOKEN=${SECRET}`], labels: { 'com.docker.compose.project': 'legacy', 'com.docker.compose.service': 'app' }, healthcheck: null, restartPolicy: 'always', privileged: false, capAdd: [], capDrop: [], networkMode: 'legacy_default', portBindings: [{ container: '80/tcp', hostIp: null, hostPort: '8088' }], exposedPorts: [], mounts: [], networks: [{ name: 'legacy_default', aliases: ['app'] }], extraHosts: [], stopSignal: null, tty: false }),
    imageConfig: async () => ({ env: ['PATH=/usr/bin'], cmd: null, entrypoint: null, workingDir: null, user: null, labels: {}, healthcheck: null }),
    readContainerFiles: async () => null,
  }
  return { ...real, portainer: () => fake }
})

describe.skipIf(!available)('reprise de l\'existant', () => {
  let dbm: typeof import('../../server/db/client')
  let mod: typeof import('../../server/services/adoption')
  let row: Awaited<ReturnType<typeof import('../../server/services/live').liveEndpoints>>[number]
  const input = { stack: 'shop', projectName: 'Boutique', slug: 'boutique', environmentKey: 'staging' as const, description: null, portApprovals: [], webExposures: [], droppedPorts: [], droppedMounts: [] }

  beforeAll(async () => {
    process.env.UPLOAD_DIR = await mkdtemp(join(tmpdir(), 'pp-adoption-'))
    await setupTestDatabase('adoption')
    dbm = await import('../../server/db/client')
    mod = await import('../../server/services/adoption')
    const { encryptSecret } = await import('../../server/utils/crypto')
    const { envelope, keyId } = encryptSecret('t')
    const [sec] = await dbm.db().insert(dbm.schema.secrets).values({ purpose: 'agent_secret', envelope, keyId }).returning()
    const [server] = await dbm.db().insert(dbm.schema.portainerServers).values({ name: 's', url: 'https://p.test', tokenSecretId: sec!.id } as never).returning()
    const [ep] = await dbm.db().insert(dbm.schema.serverEndpoints).values({ serverId: server!.id, portainerEndpointId: 1, name: 'local', type: 'docker_standalone', enabled: true } as never).returning()
    const [env] = await dbm.db().select().from(dbm.schema.environments).where((await import('drizzle-orm')).eq(dbm.schema.environments.key, 'staging'))
    await dbm.db().insert(dbm.schema.endpointEnvironments).values({ endpointId: ep!.id, environmentId: env!.id })
    await dbm.db().insert(dbm.schema.pathConfigs).values({ endpointId: ep!.id, environmentId: env!.id, workingRoot: '/srv/w', buildRoot: '/srv/b', tmpRoot: '/srv/t', runtimeRoot: '/srv/r' })
    await dbm.db().insert(dbm.schema.networks).values({ endpointId: ep!.id, dockerId: 'n-edge', name: 'edge', policy: 'allowed', role: 'traefik' } as never)
    await dbm.db().insert(dbm.schema.traefikConfigs).values({ endpointId: ep!.id, networkName: 'edge', certResolver: 'le', allowedDomains: ['*.example.org'] })
    row = { ep: ep!, server: server! }
  }, 30_000)
  afterAll(async () => {
    await (await import('../../server/queue/redis')).closeRedis().catch(() => {})
    await dbm?.closeDb()
  })

  it('inventaire : services, domaines servis, infrastructure signalée', async () => {
    const list = await mod.listAdoptable(row)
    const by = Object.fromEntries(list.map(s => [s.name, s]))
    expect(by.shop).toMatchObject({ services: ['web'], hosts: ['admin.example.org', 'shop.example.org'], managedBy: null })
    expect(by.legacy).toMatchObject({ composeFile: '/srv/legacy/compose.yml' })
    expect(by.edge!.infrastructure).toBe('Traefik')
  })

  it('aperçu : Compose converti, expositions, variables par leur nom seulement', async () => {
    const p = await mod.previewAdoption(row, input)
    expect(p.exposures).toEqual([{ service: 'web', host: 'shop.example.org', port: 3000, pathPrefix: null, middlewares: [] }])
    expect(p.droppedRoutes).toEqual(['admin.example.org → web'])
    expect(p.variables).toEqual(['API_KEY'])
    expect(p.composeText).not.toMatch(/traefik\./)
    expect(p.composeText).toContain('/data/compose/7/uploads:/app/uploads')
    expect(p.composeText).toContain('API_KEY: ${API_KEY}')
    expect(p.analysis.stackName).toBe('shop')
    expect(p.analysis.exposures[0]).toMatchObject({ host: 'shop.example.org', accepted: true })
    // Ni la valeur importée, ni le Compose final interpolé ne sortent.
    expect(JSON.stringify(p)).not.toContain(SECRET)
    expect(p.analysis.finalYaml).toBeNull()
  })

  it('reprise : routes perdues à confirmer, puis projet, cible et variables chiffrées créés', async () => {
    await expect(mod.adoptStack(row, { ...input, acceptDroppedRoutes: false }, null)).rejects.toMatchObject({ statusCode: 422 })
    const r = await mod.adoptStack(row, { ...input, acceptDroppedRoutes: true }, null)
    expect(r.upload.report.composeFiles).toEqual(['compose.yml'])
    const { eq } = await import('drizzle-orm')
    const [t] = await dbm.db().select().from(dbm.schema.projectTargets).where(eq(dbm.schema.projectTargets.id, r.targetId))
    expect(t).toMatchObject({ stackName: 'shop', portainerStackId: null, currentReleaseId: null })
    expect(t!.adoption).toMatchObject({ stack: 'shop', exposures: 1, variables: 1 })
    const { targetVariables } = await import('../../server/services/projects')
    expect(await targetVariables(t!)).toEqual({ API_KEY: { value: SECRET, secret: true } })
    const [s] = await dbm.db().select().from(dbm.schema.secrets).where(eq(dbm.schema.secrets.id, t!.envSecretId!))
    expect(s!.envelope).not.toContain(SECRET)
  })

  it('une stack déjà reprise ou un identifiant pris sont refusés', async () => {
    await expect(mod.previewAdoption(row, { ...input, slug: 'autre' })).rejects.toMatchObject({ statusCode: 422, data: { errors: { stack: expect.any(String) } } })
    await expect(mod.previewAdoption(row, { ...input, stack: 'legacy' })).rejects.toMatchObject({ data: { errors: { slug: 'Identifiant déjà utilisé' } } })
    const list = await mod.listAdoptable(row)
    expect(list.find(s => s.name === 'shop')!.managedBy).toMatchObject({ projectName: 'Boutique' })
  })

  it('autre stack : reconstruite, valeurs en variables', async () => {
    const p = await mod.previewAdoption(row, { ...input, stack: 'legacy', slug: 'legacy', projectName: 'Legacy' })
    expect(p.variables).toEqual(['TOKEN'])
    expect(p.composeText).toContain('TOKEN: ${TOKEN}')
    expect(p.composeText).toContain('8088:80')
    expect(JSON.stringify(p)).not.toContain(SECRET)
  })

  it('port custom : bloquant sans justification, levé par une justification confirmée (assistant)', async () => {
    const base = { ...input, stack: 'legacy', slug: 'legacy-j', projectName: 'Legacy J' }
    const without = await mod.previewAdoption(row, { ...base, portApprovals: [] })
    expect(without.analysis.issues.some(i => i.code === 'ports.approval' && i.service === 'app')).toBe(true)
    const unconfirmed = await mod.previewAdoption(row, { ...base, portApprovals: [{ service: 'app', published: 8088, protocol: 'tcp', justification: 'Port historique de legacy', confirmed: false }] })
    expect(unconfirmed.analysis.issues.some(i => i.code === 'ports.approval')).toBe(true)
    const justified = await mod.previewAdoption(row, { ...base, portApprovals: [{ service: 'app', published: 8088, protocol: 'tcp', justification: 'Port historique de legacy', confirmed: true }] })
    expect(justified.analysis.issues.some(i => i.code === 'ports.approval')).toBe(false)
    expect(justified.analysis.ports.find(p => p.published === 8088)).toMatchObject({ accepted: true })
  })

  it('publication web : port publié remplacé par une exposition derrière le Traefik de l\'endpoint', async () => {
    const base = { ...input, stack: 'legacy', slug: 'legacy-w', projectName: 'Legacy W', portApprovals: [] }
    const p = await mod.previewAdoption(row, { ...base, webExposures: [{ service: 'app', published: 8088, protocol: 'tcp', port: 80, host: 'legacy.example.org', pathPrefix: null }] })
    expect(p.composeText).not.toContain('8088')
    expect(p.exposures).toContainEqual(expect.objectContaining({ service: 'app', host: 'legacy.example.org', port: 80 }))
    expect(p.analysis.issues.some(i => i.code.startsWith('ports.'))).toBe(false)
    expect(p.analysis.issues.some(i => i.code === 'traefik.exposure')).toBe(false)
    expect(p.notes.some(n => n.message.includes('remplacé par l\'exposition legacy.example.org'))).toBe(true)
    // Domaine hors des domaines autorisés de l'endpoint : signalé par l'analyse.
    const bad = await mod.previewAdoption(row, { ...base, webExposures: [{ service: 'app', published: 8088, protocol: 'tcp', port: 80, host: 'legacy.autre.net', pathPrefix: null }] })
    expect(bad.analysis.issues.some(i => i.code === 'traefik.exposure')).toBe(true)
  })

  it('nouvelle archive avant la première mise en gestion', async () => {
    const { eq } = await import('drizzle-orm')
    const [t] = await dbm.db().select().from(dbm.schema.projectTargets).where(eq(dbm.schema.projectTargets.stackName, 'shop'))
    const { getTargetOr404 } = await import('../../server/services/projects')
    const u = await mod.prepareAdoptionUpload(await getTargetOr404(t!.id), null)
    expect(u.report.composeFiles).toEqual(['compose.yml'])
  })
})
