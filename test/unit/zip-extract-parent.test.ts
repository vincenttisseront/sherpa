import { mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { describe, expect, it } from 'vitest'
import { extractZip } from '../../server/lib/zip'
import { ZipStream } from '../../server/lib/zip-stream'

async function zipOf(files: Record<string, string>): Promise<Buffer> {
  const zip = new ZipStream()
  const chunks: Buffer[] = []
  zip.output.on('data', c => chunks.push(c as Buffer))
  for (const [name, content] of Object.entries(files)) await zip.add({ name, kind: 'file', mode: 0o644, mtime: new Date('2026-11-09T10:00:00'), data: Readable.from([Buffer.from(content)]) })
  await zip.finish()
  return Buffer.concat(chunks)
}

describe('extraction d\'une archive de sous-module', () => {
  it('destination dans un dossier parent absent (libs/ui sans libs dans l\'archive principale)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'zx-'))
    const file = join(dir, 'sub.zip')
    writeFileSync(file, await zipOf({ 'acme-ui-abc/ui.txt': 'interface\n' }))
    const dest = join(dir, 'source', 'libs', 'ui')
    const r = await extractZip(file, dest, { maxFiles: 100, maxTotalBytes: 1e6, timeoutMs: 10_000, stripPrefix: 'acme-ui-abc' })
    expect(r.files).toBe(1)
    expect(readFileSync(join(dest, 'ui.txt'), 'utf8')).toBe('interface\n')
    // Aucun répertoire temporaire laissé à côté.
    expect(readdirSync(join(dir, 'source', 'libs'))).toEqual(['ui'])
  })
})
