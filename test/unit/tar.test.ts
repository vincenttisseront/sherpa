import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { gzipSync } from 'node:zlib'
import { pack } from 'tar-stream'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { detectArchiveFormat, tarToZip } from '../../server/lib/tar'
import { inspectZip, readZipEntry } from '../../server/lib/zip'
import { makeZip } from '../../server/lib/zip-writer'
import { archiveFormat, fileRole, releaseView } from '../../server/services/github-releases'
import { parseRepoUrl } from '../../shared/utils/github-url'

interface E { name: string, type?: 'file' | 'directory' | 'symlink' | 'link', content?: string, linkname?: string, mode?: number }

async function makeTar(entries: E[], gzip = true): Promise<Buffer> {
  const p = pack()
  const chunks: Buffer[] = []
  p.on('data', (c: Buffer) => chunks.push(c))
  const done = new Promise(r => p.on('end', r))
  for (const e of entries) {
    if (e.type === 'directory' || e.type === 'symlink' || e.type === 'link') p.entry({ name: e.name, type: e.type, linkname: e.linkname, mode: e.mode })
    else p.entry({ name: e.name, mode: e.mode ?? 0o644 }, e.content ?? '')
  }
  p.finalize()
  await done
  const tar = Buffer.concat(chunks)
  return gzip ? gzipSync(tar) : tar
}

const LIMITS = { maxFiles: 100, maxTotalBytes: 1024 * 1024, timeoutMs: 10_000 }
let dir: string
let n = 0
beforeAll(async () => { dir = await mkdtemp(join(tmpdir(), 'tar-test-')) })
afterAll(async () => { await rm(dir, { recursive: true, force: true }) })

async function convert(entries: E[], gzip = true, limits = LIMITS) {
  const input = join(dir, `in-${++n}`)
  const output = join(dir, `out-${n}.zip`)
  await writeFile(input, await makeTar(entries, gzip))
  const format = await detectArchiveFormat(input)
  const stats = await tarToZip(input, format as 'tar.gz' | 'tar', output, limits)
  return { output, stats, format }
}

describe('archives tar et tar.gz', () => {
  it('détecte le format d\'après le contenu', async () => {
    const zip = join(dir, 'a.bin')
    await writeFile(zip, makeZip([{ name: 'compose.yml', data: 'services: {}' }]))
    expect(await detectArchiveFormat(zip)).toBe('zip')
    const tgz = join(dir, 'b.bin')
    await writeFile(tgz, await makeTar([{ name: 'a.txt', content: 'x' }]))
    expect(await detectArchiveFormat(tgz)).toBe('tar.gz')
    const tar = join(dir, 'c.bin')
    await writeFile(tar, await makeTar([{ name: 'a.txt', content: 'x' }], false))
    expect(await detectArchiveFormat(tar)).toBe('tar')
    const txt = join(dir, 'd.bin')
    await writeFile(txt, 'pas une archive')
    expect(await detectArchiveFormat(txt)).toBeNull()
  })

  it('convertit en ZIP : dossier racine, Compose, Dockerfile, droits d\'exécution, en-tête pax de GitHub ignoré', async () => {
    const { output, stats } = await convert([
      { name: 'pax_global_header', content: '52 comment=0123456789abcdef\n' },
      { name: 'app-1.2/', type: 'directory' },
      { name: 'app-1.2/compose.yml', content: 'services:\n  web:\n    image: nginx\n' },
      { name: 'app-1.2/docker/Dockerfile', content: 'FROM nginx' },
      { name: 'app-1.2/entrypoint.sh', content: '#!/bin/sh\n', mode: 0o755 },
    ])
    expect(stats).toMatchObject({ files: 3, directories: 1 })
    const report = await inspectZip(output, { maxFiles: 100, maxTotalBytes: 1e7, timeoutMs: 10_000 })
    expect(report).toMatchObject({ files: 3, rootFolder: 'app-1.2', composeFiles: ['app-1.2/compose.yml'], dockerfiles: ['app-1.2/docker/Dockerfile'] })
    expect(await readZipEntry(output, 'app-1.2/compose.yml', 1000)).toContain('image: nginx')
  })

  it('tar non compressé accepté', async () => {
    const { stats, format } = await convert([{ name: 'compose.yaml', content: 'services: {}' }], false)
    expect(format).toBe('tar')
    expect(stats.files).toBe(1)
  })

  it.each<[string, E[], RegExp]>([
    ['lien symbolique', [{ name: 'evil', type: 'symlink', linkname: '/etc/passwd' }], /Lien symbolique/],
    ['lien physique', [{ name: 'a', content: 'x' }, { name: 'b', type: 'link', linkname: 'a' }], /Lien symbolique/],
    ['remontée ..', [{ name: '../evil.txt', content: 'x' }], /Nom d'entrée refusé/],
    ['chemin absolu', [{ name: '/etc/cron.d/evil', content: 'x' }], /Nom d'entrée refusé/],
    ['doublon à la casse près', [{ name: 'App.txt', content: 'x' }, { name: 'app.txt', content: 'y' }], /double/],
  ])('refuse : %s', async (_label, entries, re) => {
    await expect(convert(entries)).rejects.toThrow(re)
  })

  it('plafonds : nombre de fichiers et taille décompressée (archive piégée)', async () => {
    await expect(convert([{ name: 'a', content: 'x' }, { name: 'b', content: 'y' }], true, { ...LIMITS, maxFiles: 1 })).rejects.toThrow(/Plus de 1 fichiers/)
    await expect(convert([{ name: 'big', content: '0'.repeat(300_000) }], true, { ...LIMITS, maxTotalBytes: 100_000 })).rejects.toThrow(/Taille décompressée/)
  })

  it('gzip tronqué refusé', async () => {
    const input = join(dir, 'trunc.tgz')
    const full = await makeTar([{ name: 'a.txt', content: 'x'.repeat(5000) }])
    await writeFile(input, full.subarray(0, Math.floor(full.length / 2)))
    await expect(tarToZip(input, 'tar.gz', join(dir, 'trunc.zip'), LIMITS)).rejects.toThrow(/invalide ou tronquée/)
  })

  it('aucun fichier partiel laissé en cas de refus', async () => {
    const input = join(dir, 'evil.tgz')
    await writeFile(input, await makeTar([{ name: 'ok.txt', content: 'x' }, { name: 'evil', type: 'symlink', linkname: '/' }]))
    const output = join(dir, 'evil.zip')
    await expect(tarToZip(input, 'tar.gz', output, LIMITS)).rejects.toThrow()
    // Le fichier de sortie éventuel est supprimé par l'appelant (storeUpload) : ici, il n'est au moins pas un ZIP valide exploitable.
    await expect(readFile(output).then(b => inspectZip(output, { maxFiles: 10, maxTotalBytes: 1e6, timeoutMs: 5000 }).then(() => b))).rejects.toThrow()
  })
})

describe('releases GitHub', () => {
  it.each([
    ['https://github.com/acme/shop/releases', { tag: null, asset: null }, null],
    ['https://github.com/acme/shop/releases/latest', { tag: null, asset: null }, null],
    ['https://github.com/acme/shop/releases/tag/v1.2.0', { tag: 'v1.2.0', asset: null }, 'v1.2.0'],
    ['https://github.com/acme/shop/releases/download/v1.2.0/shop-deploy.tar.gz', { tag: 'v1.2.0', asset: 'shop-deploy.tar.gz' }, 'v1.2.0'],
  ])('%s', (url, release, ref) => {
    expect(parseRepoUrl(url)).toMatchObject({ repository: 'acme/shop', release, ref })
  })

  it('liste tous les fichiers de la release : importables d\'abord, raison pour les autres (cas Harbor)', () => {
    expect([archiveFormat('a.zip'), archiveFormat('a.tar.gz'), archiveFormat('a.TGZ'), archiveFormat('a.tar'), archiveFormat('a.deb')]).toEqual(['zip', 'tar.gz', 'tar.gz', 'tar', null])
    expect(['x.tgz.sigstore.json', 'x.asc', 'md5sum', 'SHA256SUMS', 'checksums.txt', 'app.tar.gz', 'app.deb'].map(fileRole)).toEqual(['signature', 'signature', 'checksum', 'checksum', 'checksum', 'archive', 'other'])
    const MB = 1024 * 1024
    const v = releaseView({ tag: 'v2.15.4', name: 'v2.15.4', prerelease: false, publishedAt: null, htmlUrl: 'https://github.com/goharbor/harbor/releases/tag/v2.15.4', assets: [
      { id: 1, name: 'harbor-offline-installer-v2.15.4.tgz', size: 712 * MB, contentType: 'application/gzip' },
      { id: 2, name: 'harbor-offline-installer-v2.15.4.tgz.sigstore.json', size: 9000, contentType: 'application/json' },
      { id: 3, name: 'harbor-online-installer-v2.15.4.tgz', size: 20_000, contentType: 'application/gzip' },
      { id: 4, name: 'md5sum', size: 200, contentType: 'text/plain' },
    ] }, 'goharbor/harbor', 512 * MB)
    expect(v.files.map(f => [f.key, f.importable])).toEqual([
      ['asset:3', true],
      ['asset:1', false],
      ['asset:2', false],
      ['asset:4', false],
      ['source:tar.gz', true],
      ['source:zip', true],
    ])
    expect(v.files.find(f => f.key === 'asset:1')!.reason).toBe('Au-delà de la limite d\'import (512 Mo)')
    expect(v.files.find(f => f.key === 'asset:2')!.reason).toBe('Signature')
    expect(v.files.find(f => f.key === 'asset:4')!.reason).toBe('Sommes de contrôle')
    expect(v.files.at(-2)!.name).toBe('harbor-2.15.4.tar.gz')
  })
})
