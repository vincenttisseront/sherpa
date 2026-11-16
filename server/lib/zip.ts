/**
 * Lecture sécurisée des archives ZIP (§7.2), partagée par la plateforme
 * (inspection avant transfert) et par le Target Runner (extraction).
 *
 * Contrôles :
 * - noms d'entrée : pas de chemin absolu, de `..`, d'antislash, de caractère de contrôle ;
 * - liens symboliques et fichiers spéciaux refusés ;
 * - nombre de fichiers, taille totale et profondeur bornés ;
 * - taille réellement décompressée comptée octet par octet (les en-têtes
 *   ZIP peuvent mentir : protection contre les bombes de décompression) ;
 * - délai maximal ;
 * - extraction dans un répertoire temporaire, puis renommage atomique.
 */
import { createWriteStream } from 'node:fs'
import { mkdir, rename, rm } from 'node:fs/promises'
import { dirname, join, posix } from 'node:path'
import { Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { randomBytes } from 'node:crypto'
import yauzl from 'yauzl'
import { PathViolation, validateRelativeEntry } from '../utils/path-guard'

export interface ZipLimits {
  maxFiles: number
  maxTotalBytes: number
  maxDepth?: number
  timeoutMs: number
  /** Dossier racine à retirer (archives GitHub « org-depot-sha/ ») ; toute entrée hors de ce dossier est refusée. */
  stripPrefix?: string
}

export interface ZipReport {
  files: number
  directories: number
  totalBytes: number
  composeFiles: string[]
  dockerfiles: string[]
  /** Préfixe commun si toute l'archive est dans un seul dossier (cas des exports GitHub). */
  rootFolder: string | null
  /** Chemins des fichiers (inspection uniquement, pour valider contextes et Dockerfiles). */
  entries?: string[]
}

export class ZipRejected extends Error {
  constructor(message: string, public readonly entry?: string) {
    super(entry ? `${message} : ${entry}` : message)
    this.name = 'ZipRejected'
  }
}

const COMPOSE_NAMES = new Set(['compose.yml', 'compose.yaml', 'docker-compose.yml', 'docker-compose.yaml'])
const S_IFMT = 0o170000
const S_IFREG = 0o100000
const S_IFDIR = 0o040000

export function isComposeFile(path: string): boolean {
  return COMPOSE_NAMES.has(posix.basename(path))
}

export function isDockerfile(path: string): boolean {
  const b = posix.basename(path)
  return b === 'Dockerfile' || b.startsWith('Dockerfile.') || b.endsWith('.Dockerfile')
}

/** Messages de yauzl traduits pour l'interface. */
function translateYauzl(message: string): string {
  const rules: [RegExp, string][] = [
    [/^invalid relative path: (.*)$/, 'Nom d\'entrée refusé (remontée ..) : $1'],
    [/^absolute path: (.*)$/, 'Nom d\'entrée refusé (chemin absolu) : $1'],
    [/^invalid characters in fileName: (.*)$/, 'Nom d\'entrée refusé (caractères invalides) : $1'],
    [/too many length or distance symbols|invalid (block|code|distance)/i, 'Données compressées corrompues'],
    [/end of central directory record signature not found/i, 'Fichier ZIP invalide ou tronqué'],
    [/^(compressed|uncompressed|file data) .*(too|stream)/i, 'Taille d\'entrée incohérente avec l\'en-tête ZIP'],
  ]
  for (const [re, fr] of rules) {
    const m = re.exec(message)
    if (m) return fr.replace('$1', m[1] ?? '')
  }
  return `Archive ZIP refusée (${message})`
}

function openZip(file: string): Promise<yauzl.ZipFile> {
  return new Promise((resolve, reject) => {
    yauzl.open(file, { lazyEntries: true, autoClose: true, validateEntrySizes: true, strictFileNames: true }, (err, zip) => {
      if (err || !zip) reject(new ZipRejected(translateYauzl(err?.message ?? 'inconnue')))
      else resolve(zip)
    })
  })
}

function openEntry(zip: yauzl.ZipFile, entry: yauzl.Entry): Promise<NodeJS.ReadableStream> {
  return new Promise((resolve, reject) => {
    zip.openReadStream(entry, (err, stream) => (err || !stream ? reject(err ?? new Error('flux indisponible')) : resolve(stream)))
  })
}

/** Type de l'entrée d'après les attributs Unix (ZIP créés sous Unix) ou le nom. */
function entryKind(entry: yauzl.Entry): 'file' | 'dir' | 'other' {
  const unixMode = (entry.externalFileAttributes >>> 16) & 0xFFFF
  const isDirName = entry.fileName.endsWith('/')
  const type = unixMode & S_IFMT
  // Beaucoup d'outils (Python zipfile, certains utilitaires Windows) n'écrivent que les
  // bits de permission : sans type explicite, le nom fait foi.
  if (type === 0) return isDirName ? 'dir' : 'file'
  if (type === S_IFDIR) return 'dir'
  if (type === S_IFREG && !isDirName) return 'file'
  // Lien symbolique (0o120000), périphérique, FIFO, socket : refusés.
  return 'other'
}

/**
 * Parcourt l'archive en appliquant tous les contrôles. Si `extractTo` est
 * fourni, les fichiers sont écrits sous ce répertoire (qui doit exister).
 */
async function walk(file: string, limits: ZipLimits, extractTo?: string): Promise<ZipReport> {
  const zip = await openZip(file)
  const report: ZipReport = { files: 0, directories: 0, totalBytes: 0, composeFiles: [], dockerfiles: [], rootFolder: null }
  const maxDepth = limits.maxDepth ?? 32
  const seen = new Set<string>()
  const roots = new Set<string>()
  let hasTopLevelFile = false

  return new Promise<ZipReport>((resolve, reject) => {
    let settled = false
    const fail = (err: unknown) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      zip.close()
      reject(err instanceof ZipRejected ? err : new ZipRejected(err instanceof Error ? err.message : String(err)))
    }
    const timer = setTimeout(() => fail(new ZipRejected(`Délai d'extraction dépassé (${Math.round(limits.timeoutMs / 1000)} s)`)), limits.timeoutMs)

    zip.on('error', (err: Error) => fail(new ZipRejected(translateYauzl(err.message))))
    zip.on('end', () => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      report.rootFolder = !hasTopLevelFile && roots.size === 1 ? [...roots][0]! : null
      resolve(report)
    })

    zip.on('entry', (entry: yauzl.Entry) => {
      void (async () => {
        let rel: string
        try {
          rel = validateRelativeEntry(entry.fileName)
        }
        catch (e) {
          throw new ZipRejected(`Nom d'entrée refusé (${e instanceof PathViolation ? e.reason : 'invalide'})`, entry.fileName)
        }
        const kind = entryKind(entry)
        if (kind === 'other') throw new ZipRejected('Lien symbolique ou fichier spécial refusé', entry.fileName)
        if (limits.stripPrefix) {
          if (rel === limits.stripPrefix) rel = ''
          else if (rel.startsWith(`${limits.stripPrefix}/`)) rel = rel.slice(limits.stripPrefix.length + 1)
          else throw new ZipRejected(`Entrée hors du dossier racine « ${limits.stripPrefix} »`, entry.fileName)
        }
        if (!rel) {
          zip.readEntry()
          return
        }
        if (rel.split('/').length > maxDepth) throw new ZipRejected(`Profondeur supérieure à ${maxDepth}`, rel)
        const key = rel.toLowerCase()
        if (seen.has(key)) throw new ZipRejected('Entrée en double (éventuellement à la casse près)', rel)
        seen.add(key)
        const top = rel.split('/')[0]!
        roots.add(top)

        if (kind === 'dir') {
          report.directories++
          if (extractTo) await mkdir(join(extractTo, rel), { recursive: true, mode: 0o750 })
          zip.readEntry()
          return
        }

        if (!rel.includes('/')) hasTopLevelFile = true
        if (!extractTo) (report.entries ??= []).push(rel)
        report.files++
        if (report.files > limits.maxFiles) throw new ZipRejected(`Plus de ${limits.maxFiles} fichiers`)
        if (isComposeFile(rel)) report.composeFiles.push(rel)
        if (isDockerfile(rel)) report.dockerfiles.push(rel)

        // Comptage réel des octets décompressés.
        const counter = new Transform({
          transform(chunk: Buffer, _enc, cb) {
            report.totalBytes += chunk.length
            if (report.totalBytes > limits.maxTotalBytes) cb(new ZipRejected(`Taille décompressée supérieure à ${Math.round(limits.maxTotalBytes / 1024 / 1024)} Mo`))
            else cb(null, chunk)
          },
        })
        const source = await openEntry(zip, entry)
        if (extractTo) {
          const target = join(extractTo, rel)
          await mkdir(dirname(target), { recursive: true, mode: 0o750 })
          // 'wx' : jamais d'écrasement, ni de suivi d'un lien préexistant.
          await pipeline(source, counter, createWriteStream(target, { flags: 'wx', mode: 0o640 }))
        }
        else {
          await pipeline(source, counter, new Transform({ transform: (_c, _e, cb) => cb() }))
        }
        zip.readEntry()
      })().catch(fail)
    })

    zip.readEntry()
  })
}

/** Lit une entrée de l'archive (fichier texte limité, ex. le Compose), avec les mêmes contrôles de nom. */
export async function readZipEntry(file: string, entryPath: string, maxBytes: number): Promise<string> {
  const wanted = validateRelativeEntry(entryPath)
  const zip = await openZip(file)
  return new Promise<string>((resolve, reject) => {
    let found = false
    zip.on('error', (e: Error) => reject(new ZipRejected(translateYauzl(e.message))))
    zip.on('end', () => { if (!found) reject(new ZipRejected('Fichier absent de l\'archive', wanted)) })
    zip.on('entry', (entry: yauzl.Entry) => {
      let rel: string
      try {
        rel = validateRelativeEntry(entry.fileName)
      }
      catch {
        zip.readEntry()
        return
      }
      if (rel !== wanted || entryKind(entry) !== 'file') {
        zip.readEntry()
        return
      }
      found = true
      if (entry.uncompressedSize > maxBytes) {
        zip.close()
        reject(new ZipRejected(`Fichier trop volumineux (${maxBytes} octets maximum)`, wanted))
        return
      }
      openEntry(zip, entry).then(async (stream) => {
        const chunks: Buffer[] = []
        let size = 0
        for await (const c of stream) {
          size += (c as Buffer).length
          if (size > maxBytes) throw new ZipRejected('Fichier trop volumineux', wanted)
          chunks.push(c as Buffer)
        }
        zip.close()
        resolve(Buffer.concat(chunks).toString('utf8'))
      }).catch(reject)
    })
    zip.readEntry()
  })
}

/** Inspection sans écriture (plateforme, avant transfert vers le serveur cible). */
export function inspectZip(file: string, limits: ZipLimits): Promise<ZipReport> {
  return walk(file, limits)
}

/**
 * Extraction vers `destination`, qui ne doit pas exister. L'archive est
 * d'abord extraite dans un répertoire voisin temporaire, renommé à la fin :
 * une extraction refusée ne laisse jamais de contenu partiel.
 */
export async function extractZip(file: string, destination: string, limits: ZipLimits): Promise<ZipReport> {
  const staging = `${destination}.partial-${randomBytes(4).toString('hex')}`
  // Dossier parent créé au besoin (sous-module dans un dossier absent de l'archive principale) ; la destination elle-même ne doit pas exister.
  await mkdir(dirname(destination), { recursive: true, mode: 0o750 })
  await mkdir(staging, { recursive: false, mode: 0o750 })
  try {
    const report = await walk(file, limits, staging)
    await rename(staging, destination)
    return report
  }
  catch (err) {
    await rm(staging, { recursive: true, force: true })
    throw err
  }
}
