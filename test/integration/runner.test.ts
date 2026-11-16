/**
 * Test d'intégration du Target Runner : vrai serveur HTTPS avec mTLS, vrai
 * client de la plateforme, vrai système de fichiers (répertoire temporaire).
 */
import { randomBytes, createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync, existsSync } from 'node:fs'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Server } from 'node:https'
import { request, Agent } from 'undici'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createHttpRunner, RunnerHttpError } from '../../server/adapters/runner/http'
import type { TargetRunner } from '../../server/adapters/runner/types'
import { HEADERS, sign } from '../../server/lib/runner-signature'
import { createRunnerServer } from '../../runner/server'
import { generatePki, type TestPki } from '../../scripts/pki'
import { makeZip } from '../../server/lib/zip-writer'

const ctx = { requestId: 'test', actor: 'vitest' }
let base: string
let pki: TestPki
let server: Server
let url: string
let runner: TargetRunner
const hmacKey = randomBytes(32)
const auditLog: Record<string, unknown>[] = []

async function* streamOf(buf: Buffer) {
  yield buf
}
const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex')

async function upload(path: string, data: Buffer) {
  await runner.uploadFile(ctx, { path, sizeBytes: data.length, sha256: sha(data) }, streamOf(data))
}

const limits = { maxFiles: 100, maxTotalBytes: 1024 * 1024, timeoutSec: 10, allowSymlinks: false as const, format: 'zip' as const }

beforeAll(async () => {
  base = realpathSync(mkdtempSync(join(tmpdir(), 'runner-it-')))
  pki = generatePki(mkdtempSync(join(tmpdir(), 'runner-pki-')))
  for (const d of ['deployments', 'tmp', 'outside']) mkdirSync(join(base, d))
  server = createRunnerServer({
    port: 0,
    host: '127.0.0.1',
    roots: [join(base, 'deployments'), join(base, 'tmp')],
    hmacKey,
    tls: { cert: pki.serverCert, key: pki.serverKey, ca: pki.caCert },
    maxUploadBytes: 5 * 1024 * 1024,
    maxConcurrent: 8,
    hostname: 'test-host',
    dockerSocket: null,
    maxBuilds: 2,
    buildMaxMemoryMb: 1024,
  }, entry => auditLog.push(entry)) as Server
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r))
  url = `https://localhost:${(server.address() as AddressInfo).port}`
  runner = createHttpRunner({ url, hmacKey, caCertPem: pki.caCert, clientCertPem: pki.clientCert, clientKeyPem: pki.clientKey })
}, 60_000)

afterAll(() => {
  server?.close()
  rmSync(base, { recursive: true, force: true })
})

describe('authentification', () => {
  it('répond à health avec les racines locales', async () => {
    const h = await runner.health()
    expect(h).toMatchObject({ hostname: 'test-host', roots: [join(base, 'deployments'), join(base, 'tmp')] })
    expect(h.actions).not.toContain('build')
  })

  it('refuse une mauvaise clé HMAC', async () => {
    const bad = createHttpRunner({ url, hmacKey: randomBytes(32), caCertPem: pki.caCert, clientCertPem: pki.clientCert, clientKeyPem: pki.clientKey })
    await expect(bad.health()).rejects.toMatchObject({ status: 401, kind: 'auth' })
  })

  it('refuse un client sans certificat (mTLS)', async () => {
    const noCert = createHttpRunner({ url, hmacKey, caCertPem: pki.caCert })
    await expect(noCert.health()).rejects.toMatchObject({ kind: 'network' })
  })

  it('refuse un certificat client signé par une autre AC', async () => {
    const rogue = createHttpRunner({ url, hmacKey, caCertPem: pki.caCert, clientCertPem: pki.rogueCert, clientKeyPem: pki.rogueKey })
    await expect(rogue.health()).rejects.toMatchObject({ kind: 'network' })
  })

  it('refuse un Runner dont le certificat n\'est pas signé par l\'AC attendue', async () => {
    const wrongCa = createHttpRunner({ url, hmacKey, caCertPem: pki.rogueCert, clientCertPem: pki.clientCert, clientKeyPem: pki.clientKey })
    await expect(wrongCa.health()).rejects.toMatchObject({ kind: 'network' })
  })

  it('refuse une requête rejouée', async () => {
    const dispatcher = new Agent({ connect: { ca: pki.caCert, cert: pki.clientCert, key: pki.clientKey } })
    const body = Buffer.from(JSON.stringify({ path: join(base, 'deployments') }))
    const path = '/v1/actions/checkDir'
    const headers = { ...sign(hmacKey, 'POST', path, sha(body)), 'content-type': 'application/json' }
    const first = await request(`${url}${path}`, { method: 'POST', headers, body, dispatcher })
    expect(first.statusCode).toBe(200)
    await first.body.text()
    const replay = await request(`${url}${path}`, { method: 'POST', headers, body, dispatcher })
    expect(replay.statusCode).toBe(401)
    expect(await replay.body.text()).toMatch(/rejouée/)
  })

  it('refuse un corps modifié après signature', async () => {
    const dispatcher = new Agent({ connect: { ca: pki.caCert, cert: pki.clientCert, key: pki.clientKey } })
    const signed = Buffer.from(JSON.stringify({ path: join(base, 'deployments') }))
    const tampered = Buffer.from(JSON.stringify({ path: '/etc' }))
    const path = '/v1/actions/checkDir'
    const res = await request(`${url}${path}`, { method: 'POST', headers: { ...sign(hmacKey, 'POST', path, sha(signed)), 'content-type': 'application/json' }, body: tampered, dispatcher })
    expect(res.statusCode).toBe(401)
    await res.body.text()
  })

  it('n\'expose aucune route hors liste blanche', async () => {
    const dispatcher = new Agent({ connect: { ca: pki.caCert, cert: pki.clientCert, key: pki.clientKey } })
    const post = (path: string) => request(`${url}${path}`, { method: 'POST', headers: { ...sign(hmacKey, 'POST', path, sha(Buffer.from('{}'))), [HEADERS.contentSha256]: sha(Buffer.from('{}')) }, body: '{}', dispatcher })
    for (const path of ['/v1/actions/exec', '/v1/actions/run', '/v1/shell']) {
      const res = await post(path)
      expect(res.statusCode).toBe(404)
      await res.body.text()
    }
    // Sans socket Docker, le build est désactivé (et absent de health).
    const build = await post('/v1/actions/build')
    expect(build.statusCode).toBe(503)
    expect(await build.body.text()).toMatch(/Docker/)
  })
})

describe('chemins', () => {
  it('crée une arborescence avec le mode demandé', async () => {
    const p = join(base, 'deployments/production/app/releases')
    await runner.ensureDir(ctx, { path: p, mode: '0750' })
    expect(await runner.checkDir(ctx, { path: p })).toEqual({ exists: true, isDirectory: true, writable: true })
  })

  it.each([
    ['hors racines', () => join(base, 'outside/x')],
    ['répertoire système', () => '/etc/cron.d'],
    ['remontée', () => `${join(base, 'deployments')}/../outside`],
  ])('refuse un chemin %s', async (_l, p) => {
    await expect(runner.ensureDir(ctx, { path: p(), mode: '0750' })).rejects.toMatchObject({ status: expect.any(Number) })
  })

  it('refuse de traverser un lien symbolique posé dans une racine', async () => {
    symlinkSync(join(base, 'outside'), join(base, 'deployments/evil'))
    await expect(runner.ensureDir(ctx, { path: join(base, 'deployments/evil/x'), mode: '0750' })).rejects.toMatchObject({ status: 403 })
    expect(existsSync(join(base, 'outside/x'))).toBe(false)
  })

  it('refuse de supprimer une racine', async () => {
    await expect(runner.cleanup(ctx, { path: join(base, 'tmp') })).rejects.toMatchObject({ status: 403 })
  })
})

describe('dépôt et extraction', () => {
  it('dépose, extrait, calcule l\'empreinte puis nettoie', async () => {
    const zip = makeZip([
      { name: 'app/', mode: 0o040755 },
      { name: 'app/compose.yml', data: 'services:\n  web:\n    build: .\n' },
      { name: 'app/Dockerfile', data: 'FROM nginx:1.27\n' },
      { name: 'app/src/index.html', data: '<h1>ok</h1>' },
    ])
    const archive = join(base, 'tmp/r1.zip')
    await upload(archive, zip)
    expect(readFileSync(archive).equals(zip)).toBe(true)

    const dest = join(base, 'deployments/production/app/releases/r1')
    const r = await runner.extractArchive(ctx, { archivePath: archive, destination: dest, ...limits })
    expect(r).toMatchObject({ files: 3, composeFiles: ['app/compose.yml'], dockerfiles: ['app/Dockerfile'], rootFolder: 'app' })
    expect(readFileSync(join(dest, 'app/compose.yml'), 'utf8')).toContain('build')

    const h1 = await runner.hashTree(ctx, { path: dest })
    const h2 = await runner.hashTree(ctx, { path: dest })
    expect(h1).toEqual(h2)
    expect(h1.files).toBe(3)

    const ctxDir = join(base, 'deployments/production/app/releases/r1-context')
    expect(await runner.prepareBuildContext(ctx, { sourceDir: dest, contextDir: ctxDir, subdirectory: 'app', maxContextBytes: 1e6 })).toMatchObject({ sizeBytes: expect.any(Number) })
    expect(existsSync(join(ctxDir, 'Dockerfile'))).toBe(true)

    await runner.writeFile(ctx, { path: join(dest, 'metadata.json'), content: '{"release":"r1"}', mode: '0640' })
    expect((await runner.cleanup(ctx, { path: archive })).removedBytes).toBe(zip.length)
    expect(existsSync(archive)).toBe(false)
  })

  it('accepte les archives dont les entrées n\'ont que des bits de permission (Python, Windows)', async () => {
    const zip = makeZip([{ name: 'perm/compose.yml', data: 'services: {}', mode: 0o600 }, { name: 'perm/run.sh', data: 'echo', mode: 0o755 }])
    const archive = join(base, 'tmp/perm.zip')
    await upload(archive, zip)
    const r = await runner.extractArchive(ctx, { archivePath: archive, destination: join(base, 'deployments/production/app/releases/perm'), ...limits })
    expect(r).toMatchObject({ files: 2, composeFiles: ['perm/compose.yml'] })
  })

  it('retire le dossier racine d\'une archive GitHub et extrait dans un répertoire vide existant', async () => {
    const zip = makeZip([{ name: 'org-repo-abc123/', mode: 0o040755 }, { name: 'org-repo-abc123/compose.yml', data: 'services: {}' }, { name: 'org-repo-abc123/lib/a.txt', data: 'a' }])
    const archive = join(base, 'tmp/gh.zip')
    await upload(archive, zip)
    const dest = join(base, 'deployments/production/app/releases/gh')
    mkdirSync(dest, { recursive: true })
    const r = await runner.extractArchive(ctx, { archivePath: archive, destination: dest, ...limits, stripPrefix: 'org-repo-abc123' })
    expect(r.files).toBe(2)
    expect(readFileSync(join(dest, 'compose.yml'), 'utf8')).toBe('services: {}')
  })

  it('refuse une entrée hors du dossier racine attendu', async () => {
    const zip = makeZip([{ name: 'org-repo-abc123/a.txt', data: 'a' }, { name: 'intrus.txt', data: 'x' }])
    const archive = join(base, 'tmp/gh-intrus.zip')
    await upload(archive, zip)
    await expect(runner.extractArchive(ctx, { archivePath: archive, destination: join(base, 'deployments/production/app/releases/gh2'), ...limits, stripPrefix: 'org-repo-abc123' })).rejects.toThrow(/dossier racine/)
  })

  it('refuse une destination non vide', async () => {
    const dest = join(base, 'deployments/production/app/releases/full')
    mkdirSync(dest, { recursive: true })
    writeFileSync(join(dest, 'x'), 'x')
    const zip = makeZip([{ name: 'a.txt', data: 'a' }])
    await upload(join(base, 'tmp/full.zip'), zip)
    await expect(runner.extractArchive(ctx, { archivePath: join(base, 'tmp/full.zip'), destination: dest, ...limits })).rejects.toMatchObject({ status: 409 })
  })

  it('refuse un fichier dont l\'empreinte ne correspond pas', async () => {
    const data = Buffer.from('contenu')
    await expect(runner.uploadFile(ctx, { path: join(base, 'tmp/bad.bin'), sizeBytes: data.length, sha256: 'a'.repeat(64) }, streamOf(data))).rejects.toMatchObject({ status: 400 })
    expect(existsSync(join(base, 'tmp/bad.bin'))).toBe(false)
  })

  it('n\'écrase jamais un fichier existant', async () => {
    const data = Buffer.from('v1')
    await upload(join(base, 'tmp/once.bin'), data)
    await expect(upload(join(base, 'tmp/once.bin'), data)).rejects.toMatchObject({ status: 409 })
  })

  it.each([
    ['traversée ../', [{ name: '../evil.txt', data: 'x' }]],
    ['traversée imbriquée', [{ name: 'a/../../evil.txt', data: 'x' }]],
    ['chemin absolu', [{ name: '/tmp/evil.txt', data: 'x' }]],
    ['lien symbolique', [{ name: 'link', data: '/etc/passwd', mode: 0o120777 }]],
    ['entrée en double (casse)', [{ name: 'A.txt', data: '1' }, { name: 'a.txt', data: '2' }]],
  ])('refuse une archive avec %s sans rien laisser sur disque', async (_l, entries) => {
    const zip = makeZip(entries)
    const name = randomBytes(4).toString('hex')
    const archive = join(base, `tmp/${name}.zip`)
    await upload(archive, zip)
    const dest = join(base, `deployments/production/app/releases/${name}`)
    await expect(runner.extractArchive(ctx, { archivePath: archive, destination: dest, ...limits })).rejects.toMatchObject({ status: 422 })
    expect(existsSync(dest)).toBe(false)
    expect(existsSync(join(base, 'deployments/production/app/evil.txt'))).toBe(false)
  })

  it('refuse une archive dépassant la taille décompressée autorisée', async () => {
    const zip = makeZip([{ name: 'big.bin', data: Buffer.alloc(200_000) }])
    const archive = join(base, 'tmp/big.zip')
    await upload(archive, zip)
    await expect(runner.extractArchive(ctx, { archivePath: archive, destination: join(base, 'deployments/production/app/releases/big'), ...limits, maxTotalBytes: 100_000 })).rejects.toThrow(/Taille décompressée/)
  })

  it('refuse un nombre de fichiers excessif', async () => {
    const zip = makeZip(Array.from({ length: 5 }, (_, i) => ({ name: `f${i}.txt`, data: 'x' })))
    const archive = join(base, 'tmp/many.zip')
    await upload(archive, zip)
    await expect(runner.extractArchive(ctx, { archivePath: archive, destination: join(base, 'deployments/production/app/releases/many'), ...limits, maxFiles: 3 })).rejects.toThrow(/fichiers/)
  })

  it('purge les fichiers temporaires anciens sans toucher aux récents', async () => {
    writeFileSync(join(base, 'tmp/recent.bin'), 'x')
    const r = await runner.cleanup(ctx, { path: join(base, 'tmp'), olderThanSec: 3600 })
    expect(r.removedBytes).toBe(0)
    expect(existsSync(join(base, 'tmp/recent.bin'))).toBe(true)
  })

  it('renvoie l\'espace disque', async () => {
    const d = await runner.diskUsage(ctx, { path: join(base, 'deployments') })
    expect(d.freeBytes).toBeGreaterThan(0)
    expect(d.totalBytes).toBeGreaterThanOrEqual(d.freeBytes)
  })
})

describe('audit local', () => {
  it('trace chaque requête, y compris les refus, sans contenu de fichier', () => {
    expect(auditLog.some(e => e.outcome === 'denied')).toBe(true)
    expect(auditLog.some(e => e.action === 'extractArchive' && e.outcome === 'success')).toBe(true)
    expect(JSON.stringify(auditLog)).not.toContain('{"release":"r1"}')
  })

  it('le client signale ses erreurs typées', () => {
    expect(new RunnerHttpError('x', 403, 'denied')).toBeInstanceOf(Error)
  })
})
