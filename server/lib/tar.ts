/**
 * Archives tar et tar.gz (releases GitHub, exports) converties en ZIP à la
 * réception : le reste du circuit (inspection, transfert au Runner,
 * extraction, lecture du Compose) ne manipule que des ZIP. Les règles sont
 * celles des ZIP : noms relatifs sans remontée, pas de lien ni de fichier
 * spécial, nombre de fichiers et taille décompressée plafonnés, délai borné.
 * L'archive ZIP produite est de toute façon réinspectée ensuite.
 */
import { createReadStream, createWriteStream } from 'node:fs'
import { open } from 'node:fs/promises'
import { type Readable, Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { createGunzip } from 'node:zlib'
import { extract } from 'tar-stream'
import yazl from 'yazl'
import { PathViolation, validateRelativeEntry } from '../utils/path-guard'
import { ZipRejected } from './zip'

export type ArchiveFormat = 'zip' | 'tar.gz' | 'tar'

/** Format d'après le contenu (jamais d'après le nom) : signature ZIP, gzip, ou « ustar » à l'octet 257. */
export async function detectArchiveFormat(file: string): Promise<ArchiveFormat | null> {
  const fh = await open(file, 'r')
  try {
    const buf = Buffer.alloc(512)
    const { bytesRead } = await fh.read(buf, 0, 512, 0)
    if (bytesRead >= 4 && buf.readUInt32LE(0) === 0x04034B50) return 'zip'
    // ZIP vide (fin de répertoire central seule) : refusé plus loin comme archive vide.
    if (bytesRead >= 4 && buf.readUInt32LE(0) === 0x06054B50) return 'zip'
    if (bytesRead >= 2 && buf[0] === 0x1F && buf[1] === 0x8B) return 'tar.gz'
    if (bytesRead >= 262 && buf.subarray(257, 262).toString('latin1') === 'ustar') return 'tar'
    return null
  }
  finally {
    await fh.close()
  }
}

export interface TarLimits {
  maxFiles: number
  maxTotalBytes: number
  timeoutMs: number
}

// En-têtes de métadonnées (pax, noms longs GNU) : interprétés par tar-stream, sans contenu à reprendre.
const METADATA = new Set(['pax-header', 'pax-global-header', 'gnu-long-path', 'gnu-long-link-path'])

/** Convertit une archive tar (gzip ou non) en ZIP ; refuse tout ce qu'un ZIP refuserait. */
export async function tarToZip(input: string, format: 'tar.gz' | 'tar', output: string, limits: TarLimits): Promise<{ files: number, directories: number, totalBytes: number }> {
  const zip = new yazl.ZipFile()
  const written = pipeline(zip.outputStream, createWriteStream(output, { flags: 'wx', mode: 0o600 }))
  const ex = extract()
  const seen = new Set<string>()
  const stats = { files: 0, directories: 0, totalBytes: 0 }

  ex.on('entry', (header, stream, next) => {
    // Une erreur de l'extraction est aussi propagée au flux de l'entrée en cours : traitée par la conversion.
    stream.on('error', () => {})
    const fail = (err: Error) => {
      stream.resume()
      ex.destroy(err)
    }
    if (METADATA.has(header.type ?? '')) {
      stream.on('end', next).resume()
      return
    }
    const raw = header.name.replace(/^\.\//, '')
    // GitHub place un en-tête « pax_global_header » (identifiant du commit) en tête de ses archives.
    if (!raw || raw === '.' || raw === 'pax_global_header') {
      stream.on('end', next).resume()
      return
    }
    let rel: string
    try {
      rel = validateRelativeEntry(raw.replace(/\/+$/, ''))
    }
    catch (e) {
      fail(new ZipRejected(`Nom d'entrée refusé (${e instanceof PathViolation ? e.reason : 'invalide'})`, header.name))
      return
    }
    const key = rel.toLowerCase()
    if (seen.has(key)) {
      fail(new ZipRejected('Entrée en double (éventuellement à la casse près)', rel))
      return
    }
    seen.add(key)
    const mtime = header.mtime instanceof Date && !Number.isNaN(header.mtime.getTime()) ? header.mtime : new Date(0)

    if (header.type === 'directory') {
      stats.directories++
      zip.addEmptyDirectory(rel, { mtime, mode: 0o40755 })
      stream.on('end', next).resume()
      return
    }
    if (header.type !== 'file' && header.type !== 'contiguous-file') {
      fail(new ZipRejected('Lien symbolique ou fichier spécial refusé', rel))
      return
    }
    stats.files++
    if (stats.files > limits.maxFiles) {
      fail(new ZipRejected(`Plus de ${limits.maxFiles} fichiers`))
      return
    }
    // Comptage réel des octets décompressés (archive gzip piégée).
    const counter = new Transform({
      transform(chunk: Buffer, _e, cb) {
        stats.totalBytes += chunk.length
        if (stats.totalBytes > limits.maxTotalBytes) cb(new ZipRejected(`Taille décompressée supérieure à ${Math.round(limits.maxTotalBytes / 1024 / 1024)} Mo`))
        else cb(null, chunk)
      },
    })
    counter.on('error', err => ex.destroy(err))
    stream.pipe(counter)
    const exec = ((header.mode ?? 0o644) & 0o111) !== 0
    zip.addReadStream(counter, rel, { mtime, mode: exec ? 0o100755 : 0o100644, size: header.size })
    // L'entrée suivante n'est lue qu'une fois celle-ci entièrement reprise dans le ZIP.
    counter.on('end', next)
  })

  let timer: NodeJS.Timeout | undefined
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      const err = new ZipRejected(`Délai de conversion dépassé (${Math.round(limits.timeoutMs / 1000)} s)`)
      ex.destroy(err)
      reject(err)
    }, limits.timeoutMs)
  })
  try {
    const parse = format === 'tar.gz' ? pipeline(createReadStream(input), createGunzip(), ex) : pipeline(createReadStream(input), ex)
    await Promise.race([parse, timeout])
    zip.end()
    await written
    return stats
  }
  catch (err) {
    ;(zip.outputStream as unknown as Readable).destroy()
    await written.catch(() => {})
    if (err instanceof ZipRejected) throw err
    const msg = (err as Error).message ?? ''
    if (/incorrect header check|unexpected end of file|invalid (block|distance|code)/i.test(msg)) throw new ZipRejected('Archive gzip invalide ou tronquée')
    if (/invalid tar header|unexpected end of data/i.test(msg)) throw new ZipRejected('Archive tar invalide ou tronquée')
    throw new ZipRejected(`Archive tar refusée (${msg.slice(0, 160)})`)
  }
  finally {
    clearTimeout(timer)
  }
}
