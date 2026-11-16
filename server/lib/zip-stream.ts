/**
 * Écriture d'une archive ZIP en flux (deflate), entrée après entrée, sans connaître les tailles à
 * l'avance (descripteurs de données) : base de « Créer une archive zip » et « Télécharger en zip »
 * de l'explorateur. Dossiers, fichiers et liens symboliques (mode Unix conservé). Limites du format
 * ZIP classique (sans ZIP64) : 4 Gio et 65 535 entrées, au-delà une erreur explicite.
 */
import { PassThrough, type Readable } from 'node:stream'
import { crc32, createDeflateRaw } from 'node:zlib'

const MAX_32 = 0xFFFF_FFFF
const MAX_ENTRIES = 0xFFFF

export class ZipLimitError extends Error {}

export interface ZipEntryInput {
  name: string
  kind: 'file' | 'dir' | 'symlink'
  /** Mode Unix des permissions (ex. 0o644). */
  mode: number
  mtime: Date
  /** Contenu d'un fichier (flux) ; cible d'un lien. */
  data?: Readable
  linkname?: string
}

function dosTime(d: Date): { time: number, date: number } {
  const y = Math.max(1980, d.getFullYear())
  return {
    time: (d.getHours() << 11) | (d.getMinutes() << 5) | Math.floor(d.getSeconds() / 2),
    date: ((y - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate(),
  }
}

interface Central { name: Buffer, method: number, time: number, date: number, crc: number, comp: number, size: number, attr: number, offset: number }

export class ZipStream {
  readonly output = new PassThrough()
  private offset = 0
  private readonly centrals: Central[] = []

  private async write(buf: Buffer) {
    this.offset += buf.length
    if (this.offset > MAX_32) throw new ZipLimitError('Archive de plus de 4 Go : trop grande pour le format zip')
    if (!this.output.write(buf)) await new Promise(r => this.output.once('drain', r))
  }

  async add(e: ZipEntryInput): Promise<void> {
    if (this.centrals.length >= MAX_ENTRIES) throw new ZipLimitError('Plus de 65 535 éléments : trop pour le format zip')
    const name = Buffer.from(e.kind === 'dir' && !e.name.endsWith('/') ? `${e.name}/` : e.name, 'utf8')
    const method = e.kind === 'file' ? 8 : 0
    const { time, date } = dosTime(e.mtime)
    const type = e.kind === 'dir' ? 0o040000 : e.kind === 'symlink' ? 0o120000 : 0o100000
    const offset = this.offset

    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034B50, 0)
    local.writeUInt16LE(20, 4)
    local.writeUInt16LE(0x0808, 6) // descripteur de données + noms UTF-8
    local.writeUInt16LE(method, 8)
    local.writeUInt16LE(time, 10)
    local.writeUInt16LE(date, 12)
    local.writeUInt16LE(name.length, 26)
    await this.write(Buffer.concat([local, name]))

    let crc = 0
    let size = 0
    let comp = 0
    if (e.kind === 'file' && e.data) {
      const deflate = createDeflateRaw({ level: 6 })
      const done = (async () => {
        for await (const chunk of deflate) {
          comp += (chunk as Buffer).length
          await this.write(chunk as Buffer)
        }
      })()
      for await (const chunk of e.data) {
        const b = chunk as Buffer
        crc = crc32(b, crc)
        size += b.length
        if (size > MAX_32) throw new ZipLimitError(`${e.name} : fichier de plus de 4 Go, trop grand pour le format zip`)
        if (!deflate.write(b)) await new Promise(r => deflate.once('drain', r))
      }
      deflate.end()
      await done
    }
    else if (e.kind === 'symlink') {
      const target = Buffer.from(e.linkname ?? '', 'utf8')
      crc = crc32(target)
      size = comp = target.length
      await this.write(target)
    }

    const desc = Buffer.alloc(16)
    desc.writeUInt32LE(0x08074B50, 0)
    desc.writeUInt32LE(crc >>> 0, 4)
    desc.writeUInt32LE(comp, 8)
    desc.writeUInt32LE(size, 12)
    await this.write(desc)
    this.centrals.push({ name, method, time, date, crc: crc >>> 0, comp, size, attr: (((type | (e.mode & 0o7777)) & 0xFFFF) << 16) >>> 0, offset })
  }

  async finish(): Promise<void> {
    const start = this.offset
    for (const c of this.centrals) {
      const h = Buffer.alloc(46)
      h.writeUInt32LE(0x02014B50, 0)
      h.writeUInt16LE((3 << 8) | 20, 4) // créé sous Unix : attributs externes = mode Unix
      h.writeUInt16LE(20, 6)
      h.writeUInt16LE(0x0808, 8)
      h.writeUInt16LE(c.method, 10)
      h.writeUInt16LE(c.time, 12)
      h.writeUInt16LE(c.date, 14)
      h.writeUInt32LE(c.crc, 16)
      h.writeUInt32LE(c.comp, 20)
      h.writeUInt32LE(c.size, 24)
      h.writeUInt16LE(c.name.length, 28)
      h.writeUInt32LE(c.attr, 38)
      h.writeUInt32LE(c.offset, 42)
      await this.write(Buffer.concat([h, c.name]))
    }
    const end = Buffer.alloc(22)
    end.writeUInt32LE(0x06054B50, 0)
    end.writeUInt16LE(this.centrals.length, 8)
    end.writeUInt16LE(this.centrals.length, 10)
    end.writeUInt32LE(this.offset - start, 12)
    end.writeUInt32LE(start, 16)
    await this.write(end)
    this.output.end()
  }
}
