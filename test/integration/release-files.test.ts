import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { makeZip } from '../../server/lib/zip-writer'
import { type PathConfigRow, prepareReleaseFiles, removeReleaseDirs } from '../../server/services/release-files'
import { startTestRunner, tempBase } from '../helpers/runner'

let base: string
let t: Awaited<ReturnType<typeof startTestRunner>>
const ctx = { requestId: 'it', actor: 'vitest' }

const zip = makeZip([
  { name: 'compose.yml', data: 'services:\n  web:\n    build: .\n' },
  { name: 'Dockerfile', data: 'FROM nginx:1.27\n' },
  { name: 'src/index.html', data: '<h1>v1</h1>' },
])
const archive = (buf = zip) => ({
  sizeBytes: buf.length,
  sha256: createHash('sha256').update(buf).digest('hex'),
  open: async () => Readable.from([buf]),
})

let paths: PathConfigRow
function input(over: Partial<Parameters<typeof prepareReleaseFiles>[0]> = {}) {
  const logs: string[] = []
  return {
    logs,
    args: {
      runner: t.runner, ctx, paths, projectSlug: 'demo-app', releaseSlug: 'r-0001-abc123', environmentKey: 'production',
      archive: archive(), maxFiles: 1000, extractTimeoutSec: 30, createdAt: new Date('2026-10-08T10:00:00Z'),
      log: async (m: string) => { logs.push(m) },
      ...over,
    },
  }
}

beforeAll(async () => {
  base = tempBase('release-it-')
  for (const d of ['deployments', 'builds', 'tmp', 'apps-data']) mkdirSync(join(base, d))
  t = await startTestRunner(['deployments', 'builds', 'tmp', 'apps-data'].map(d => join(base, d)))
  paths = {
    workingRoot: join(base, 'deployments/production'), buildRoot: join(base, 'builds/production'),
    tmpRoot: join(base, 'tmp/production'), runtimeRoot: join(base, 'apps-data/production'),
    forbiddenPaths: [], autoCreate: true, dirMode: '0750', ownerUid: null, groupGid: null,
    minFreeDiskMb: 1, maxProjectSizeMb: 10,
  }
}, 60_000)

afterAll(async () => {
  await t?.close()
  rmSync(base, { recursive: true, force: true })
})

describe('prepareReleaseFiles', () => {
  it('crée l\'arborescence §6.2, extrait, écrit metadata.json et nettoie le temporaire', async () => {
    const { args, logs } = input()
    const r = await prepareReleaseFiles(args)
    const rel = join(base, 'deployments/production/demo-app/releases/r-0001-abc123')
    expect(r).toMatchObject({ releaseDir: rel, sourceDir: `${rel}/source`, files: 3, reused: false })
    expect(readFileSync(`${rel}/source/compose.yml`, 'utf8')).toContain('build')
    for (const d of ['deployments/production/demo-app/shared', 'builds/production/demo-app', 'apps-data/production/demo-app', 'tmp/production/demo-app']) {
      expect(existsSync(join(base, d))).toBe(true)
    }
    const meta = JSON.parse(readFileSync(`${rel}/metadata.json`, 'utf8'))
    expect(meta).toMatchObject({ release: 'r-0001-abc123', project: 'demo-app', environment: 'production', sourceTreeSha256: r.treeSha256, composeFiles: ['compose.yml'] })
    expect(existsSync(join(base, 'tmp/production/demo-app/r-0001-abc123.zip'))).toBe(false)
    expect(logs.join('\n')).toMatch(/Racine|Arborescence/)
    expect(logs.join('\n')).toMatch(/Compose détecté/)
  })

  it('réutilise une extraction intacte lors d\'une reprise, sans retransférer', async () => {
    const first = await prepareReleaseFiles(input({ releaseSlug: 'r-0002-aaaaaa' }).args)
    let opened = false
    const again = input({ releaseSlug: 'r-0002-aaaaaa', previousTreeSha256: first.treeSha256, archive: { ...archive(), open: async () => { opened = true; return Readable.from([zip]) } } })
    const r = await prepareReleaseFiles(again.args)
    expect(r.reused).toBe(true)
    expect(opened).toBe(false)
  })

  it('ré-extrait si les sources ont été modifiées sur l\'hôte', async () => {
    const first = await prepareReleaseFiles(input({ releaseSlug: 'r-0003-bbbbbb' }).args)
    writeFileSync(join(base, 'deployments/production/demo-app/releases/r-0003-bbbbbb/source/src/index.html'), 'altéré')
    const again = input({ releaseSlug: 'r-0003-bbbbbb', previousTreeSha256: first.treeSha256 })
    const r = await prepareReleaseFiles(again.args)
    expect(r.reused).toBe(false)
    expect(r.treeSha256).toBe(first.treeSha256)
    expect(again.logs.join('\n')).toMatch(/modifiée/)
  })

  it('refuse une archive plus grosse que la taille maximale d\'un projet', async () => {
    const big = makeZip([{ name: 'big.bin', data: Buffer.alloc(2 * 1024 * 1024) }])
    await expect(prepareReleaseFiles(input({ releaseSlug: 'r-0004-cccccc', archive: archive(big), paths: { ...paths, maxProjectSizeMb: 1 } }).args)).rejects.toThrow(/taille maximale/)
  })

  it('refuse de démarrer si l\'espace disque est insuffisant', async () => {
    await expect(prepareReleaseFiles(input({ releaseSlug: 'r-0005-dddddd', paths: { ...paths, minFreeDiskMb: 100_000_000 } }).args)).rejects.toThrow(/Espace disque insuffisant/)
  })

  it('ne crée pas une racine absente si la création automatique est désactivée', async () => {
    const p = { ...paths, workingRoot: join(base, 'deployments/staging'), autoCreate: false }
    await expect(prepareReleaseFiles(input({ paths: p }).args)).rejects.toThrow(/création automatique désactivée/)
    expect(existsSync(join(base, 'deployments/staging'))).toBe(false)
  })

  it('nettoie le temporaire même quand l\'extraction échoue', async () => {
    const evil = makeZip([{ name: '../evil.txt', data: 'x' }])
    await expect(prepareReleaseFiles(input({ releaseSlug: 'r-0006-eeeeee', archive: archive(evil) }).args)).rejects.toThrow(/remontée/)
    expect(existsSync(join(base, 'tmp/production/demo-app/r-0006-eeeeee.zip'))).toBe(false)
    expect(existsSync(join(base, 'deployments/production/demo-app/releases/r-0006-eeeeee/source'))).toBe(false)
  })

  it('la rétention ne supprime que les releases demandées', async () => {
    const r = await prepareReleaseFiles(input({ releaseSlug: 'r-0007-ffffff' }).args)
    await removeReleaseDirs(t.runner, ctx, r.layout, ['r-0002-aaaaaa'])
    expect(existsSync(join(base, 'deployments/production/demo-app/releases/r-0002-aaaaaa'))).toBe(false)
    expect(existsSync(join(base, 'deployments/production/demo-app/releases/r-0007-ffffff'))).toBe(true)
    expect(() => r.layout.release('../other')).toThrow()
  })
})
