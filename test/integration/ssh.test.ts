/**
 * Transport SSH contre l'hôte de dev (service ssh-host de compose.dev.yml, npm run dev:ssh-setup).
 * Ignoré si l'hôte ou ses identifiants sont absents. Mêmes garanties que l'agent et le Runner.
 */
import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { connect } from 'node:net'
import { afterAll, describe, expect, it } from 'vitest'
import { createSshAdapter } from '../../server/adapters/portainer/ssh'
import { createSshRunner, sftpPermissionMessage } from '../../server/adapters/runner/ssh'
import { closeSshSessions, scanHostKey } from '../../server/adapters/ssh/session'
import { makeZip } from '../../server/lib/zip-writer'

const KEY = '.data/dev-ssh/id_ed25519'
const reachable = existsSync(KEY) && await new Promise<boolean>((resolve) => {
  const s = connect(12222, '127.0.0.1', () => { s.end(); resolve(true) })
  s.on('error', () => resolve(false))
  s.setTimeout(1000, () => { s.destroy(); resolve(false) })
})

describe.skipIf(!reachable)('transport SSH (hôte de dev)', async () => {
  const hostKey = reachable ? (await scanHostKey('127.0.0.1', 12222)).fingerprint : ''
  const ssh = { host: '127.0.0.1', port: 12222, username: 'deploy', hostKey, dockerSocket: '/var/run/docker.sock', privateKey: reachable ? readFileSync(KEY, 'utf8') : '' }
  const conn = { transport: 'ssh' as const, url: 'ssh://deploy@127.0.0.1:12222', token: '', tlsVerify: true, ssh }
  const adapter = createSshAdapter({ timeoutMs: 30_000, maxRetries: 0 })
  const ctx = { requestId: 'test', actor: 'test' }
  const root = `/srv/apps/test-${Date.now()}`
  const runner = createSshRunner(ssh, [root])
  afterAll(async () => {
    await runner.cleanup(ctx, { path: root, olderThanSec: 0 }).catch(() => {})
    await closeSshSessions()
  })

  it('API Docker par le socket de l\'hôte', async () => {
    expect((await adapter.getVersion(conn)).version).toMatch(/^Docker \d+.*\(SSH\)$/)
    expect((await adapter.listEndpoints(conn))[0]!.kind).toBe('docker_standalone')
  })

  it('clé d\'hôte différente ou non confirmée : connexion refusée', async () => {
    await expect(adapter.getVersion({ ...conn, ssh: { ...ssh, hostKey: `SHA256:${'B'.repeat(43)}` } })).rejects.toMatchObject({ kind: 'tls' })
    await expect(adapter.getVersion({ ...conn, ssh: { ...ssh, hostKey: null } })).rejects.toMatchObject({ kind: 'tls' })
  })

  it('actions du Runner par SFTP : dépôt vérifié, extraction, empreinte, nettoyage', async () => {
    await runner.ensureDir(ctx, { path: root, mode: '0750' })
    const zip = makeZip([{ name: 'app/compose.yml', data: 'services: {}\n' }])
    const sha = createHash('sha256').update(zip).digest('hex')
    await expect(runner.uploadFile(ctx, { path: `${root}/bad.zip`, sizeBytes: zip.length, sha256: 'a'.repeat(64) }, (async function* () { yield zip })())).rejects.toMatchObject({ kind: 'invalid' })
    await runner.uploadFile(ctx, { path: `${root}/a.zip`, sizeBytes: zip.length, sha256: sha }, (async function* () { yield zip })())
    const r = await runner.extractArchive(ctx, { archivePath: `${root}/a.zip`, destination: `${root}/src`, format: 'zip', maxFiles: 10, maxTotalBytes: 1e6, timeoutSec: 30, allowSymlinks: false })
    expect(r.composeFiles).toEqual(['app/compose.yml'])
    expect((await runner.hashTree(ctx, { path: `${root}/src` })).files).toBe(1)
    expect((await runner.diskUsage(ctx, { path: root })).freeBytes).toBeGreaterThan(0)
  })

  it('racine sous un dossier de root : créée avec les droits du moteur Docker, attribuée au compte SSH', async () => {
    const locked = `/opt/platform-auto-${Date.now()}`
    const r = createSshRunner(ssh, [locked])
    await r.ensureDir(ctx, { path: locked, mode: '0750' })
    expect(await r.checkDir(ctx, { path: locked })).toEqual({ exists: true, isDirectory: true, writable: true })
    expect(sftpPermissionMessage('/srv/x', 'deploy')).toMatch(/^Permission refusée sur \/srv\/x pour le compte SSH deploy : .*chown -R deploy:/)
  })

  it('hors des racines : refusé', async () => {
    await expect(runner.checkDir(ctx, { path: '/home/deploy' })).rejects.toMatchObject({ kind: 'denied' })
  })
})
