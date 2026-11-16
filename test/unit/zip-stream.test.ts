import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, readlinkSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { describe, expect, it } from 'vitest'
import { ZipStream } from '../../server/lib/zip-stream'

const hasUnzip = (() => {
  try {
    execFileSync('unzip', ['-v'], { stdio: 'ignore' })
    return true
  }
  catch {
    return false
  }
})()

describe('zip en flux', () => {
  it.skipIf(!hasUnzip)('archive relue à l\'identique par unzip (contenu compressé, dossiers, droits, lien)', async () => {
    const zip = new ZipStream()
    const chunks: Buffer[] = []
    zip.output.on('data', c => chunks.push(c as Buffer))
    const big = Buffer.alloc(300_000, 'abc')
    const at = new Date('2026-10-29T12:00:00')
    await zip.add({ name: 'conf', kind: 'dir', mode: 0o755, mtime: at })
    await zip.add({ name: 'conf/core.conf', kind: 'file', mode: 0o600, mtime: at, data: Readable.from([Buffer.from('port=1\n')]) })
    await zip.add({ name: 'gros.bin', kind: 'file', mode: 0o644, mtime: at, data: Readable.from([big.subarray(0, 100_000), big.subarray(100_000)]) })
    await zip.add({ name: 'lien', kind: 'symlink', mode: 0o777, mtime: at, linkname: 'conf/core.conf' })
    await zip.finish()
    const buf = Buffer.concat(chunks)
    expect(buf.length).toBeLessThan(big.length / 10)
    const dir = mkdtempSync(join(tmpdir(), 'zs-'))
    writeFileSync(join(dir, 'a.zip'), buf)
    execFileSync('unzip', ['-q', join(dir, 'a.zip'), '-d', join(dir, 'out')])
    expect(readFileSync(join(dir, 'out/conf/core.conf'), 'utf8')).toBe('port=1\n')
    expect(readFileSync(join(dir, 'out/gros.bin')).equals(big)).toBe(true)
    expect(statSync(join(dir, 'out/conf/core.conf')).mode & 0o777).toBe(0o600)
    expect(readlinkSync(join(dir, 'out/lien'))).toBe('conf/core.conf')
    expect(execFileSync('unzip', ['-tq', join(dir, 'a.zip')], { encoding: 'utf8' })).toContain('No errors')
  })
})
