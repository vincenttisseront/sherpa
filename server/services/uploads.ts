/**
 * Archives déposées (§7.2) : réception en flux sur la plateforme, taille
 * plafonnée, empreinte SHA-256, inspection complète AVANT tout transfert vers
 * un serveur cible. Les archives tar et tar.gz sont converties en ZIP à la
 * réception (mêmes contrôles) : la suite du circuit ne traite que des ZIP.
 * Le fichier local est supprimé une fois consommé, ou purgé s'il n'est jamais utilisé.
 */
import { createHash, randomUUID } from 'node:crypto'
import { createReadStream, createWriteStream } from 'node:fs'
import { mkdir, rename, rm, stat } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { Transform, type Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { and, eq, isNull, lt } from 'drizzle-orm'
import { db, schema } from '../db/client'
import { type ArchiveFormat, detectArchiveFormat, tarToZip } from '../lib/tar'
import { type ZipReport, ZipRejected, inspectZip } from '../lib/zip'
import { env } from '../utils/env'
import { type Progress, noProgress } from '../utils/progress'

export class UploadRejected extends Error {
  constructor(message: string, public readonly status = 422) {
    super(message)
    this.name = 'UploadRejected'
  }
}

export function uploadDir(): string {
  return resolve(env().UPLOAD_DIR)
}

/** Nom d'origine conservé pour l'affichage uniquement (jamais utilisé comme chemin). */
function cleanName(name: string): string {
  const base = name.split(/[\\/]/).pop() ?? 'archive.zip'
  // eslint-disable-next-line no-control-regex
  return base.replace(/[\u0000-\u001F\u007F]/g, '').slice(0, 200) || 'archive.zip'
}

export interface StoredUpload {
  id: string
  originalName: string
  /** Taille et empreinte de l'archive ZIP stockée (celle transmise au Runner). */
  sizeBytes: number
  sha256: string
  report: ZipReport & {
    /** Archive reçue dans un autre format puis convertie en ZIP : format, taille et empreinte d'origine. */
    source?: { format: Exclude<ArchiveFormat, 'zip'>, sizeBytes: number, sha256: string }
    /** Archive importée depuis une release GitHub (reconstruction sur une release suivante). */
    githubRelease?: GithubReleaseOrigin
  }
}

export interface GithubReleaseOrigin { apiUrl: string, repository: string, tag: string, archiveKey: string, archiveName: string }

async function sha256File(path: string): Promise<string> {
  const h = createHash('sha256')
  await pipeline(createReadStream(path), new Transform({ transform: (c: Buffer, _e, cb) => { h.update(c); cb() } }))
  return h.digest('hex')
}

export async function storeUpload(body: Readable, originalName: string, userId: string | null, progress: Progress = noProgress): Promise<StoredUpload> {
  const e = env()
  const maxBytes = e.UPLOAD_MAX_MB * 1024 * 1024
  await mkdir(uploadDir(), { recursive: true, mode: 0o700 })
  const id = randomUUID()
  const storagePath = join(uploadDir(), `${id}.zip`)
  const receivedPath = join(uploadDir(), `${id}.upload`)
  const hash = createHash('sha256')
  let size = 0

  try {
    await progress.step('Réception de l\'archive', 1, 3)
    await pipeline(body, new Transform({
      transform(chunk: Buffer, _e, cb) {
        size += chunk.length
        if (size > maxBytes) return cb(new UploadRejected(`Archive supérieure à ${e.UPLOAD_MAX_MB} Mo`, 413))
        hash.update(chunk)
        cb(null, chunk)
      },
    }), createWriteStream(receivedPath, { flags: 'wx', mode: 0o600 }))
    if (size === 0) throw new UploadRejected('Archive vide')

    const format = await detectArchiveFormat(receivedPath)
    if (!format) throw new UploadRejected('Format non reconnu : archive ZIP, tar.gz (.tgz) ou tar attendue')
    const receivedSha = hash.digest('hex')
    // Plafond global ; la taille maximale par projet est revérifiée au déploiement.
    const limits = { maxFiles: e.ZIP_MAX_FILES, maxTotalBytes: maxBytes * 8, timeoutMs: e.ZIP_TIMEOUT_SEC * 1000 }
    let source: StoredUpload['report']['source']
    if (format === 'zip') {
      await rename(receivedPath, storagePath)
    }
    else {
      await progress.step(`Conversion de l'archive ${format} (${(size / 1024 / 1024).toFixed(1)} Mo) : entrées, chemins, liens, taille décompressée`, 2, 3)
      try {
        await tarToZip(receivedPath, format, storagePath, limits)
      }
      catch (err) {
        throw new UploadRejected(err instanceof ZipRejected ? err.message : `Archive ${format} invalide`)
      }
      finally {
        await rm(receivedPath, { force: true })
      }
      source = { format, sizeBytes: size, sha256: receivedSha }
    }
    const storedSize = format === 'zip' ? size : (await stat(storagePath)).size
    const storedSha = format === 'zip' ? receivedSha : await sha256File(storagePath)

    await progress.step(`Contrôle de sécurité de l'archive (${(storedSize / 1024 / 1024).toFixed(1)} Mo) : entrées, chemins, liens, taille décompressée`, 2, 3)
    let report: ZipReport
    try {
      report = await inspectZip(storagePath, limits)
    }
    catch (err) {
      throw new UploadRejected(err instanceof ZipRejected ? err.message : 'Archive ZIP invalide')
    }
    if (report.files === 0) throw new UploadRejected('L\'archive ne contient aucun fichier')

    await progress.step(`Enregistrement : ${report.files} fichier(s), ${report.composeFiles.length} Compose trouvé(s)${source ? ` (converti depuis ${source.format})` : ''}`, 3, 3)
    const name = cleanName(originalName)
    const fullReport = { ...report, ...(source ? { source } : {}) }
    await db().insert(schema.uploads).values({ id, storagePath, originalName: name, sizeBytes: storedSize, sha256: storedSha, report: fullReport, uploadedBy: userId })
    return { id, originalName: name, sizeBytes: storedSize, sha256: storedSha, report: fullReport }
  }
  catch (err) {
    await rm(storagePath, { force: true })
    await rm(receivedPath, { force: true })
    throw err
  }
}

export async function getUpload(id: string) {
  const [u] = await db().select().from(schema.uploads).where(eq(schema.uploads.id, id))
  return u
}

/** Flux de lecture du fichier déposé, avec vérification qu'il n'a pas été modifié sur disque. */
export async function openUpload(u: { storagePath: string, sizeBytes: number }): Promise<Readable> {
  const s = await stat(u.storagePath)
  if (s.size !== u.sizeBytes) throw new Error('Archive locale modifiée depuis son dépôt')
  return createReadStream(u.storagePath)
}

export async function consumeUpload(id: string): Promise<void> {
  const u = await getUpload(id)
  if (!u) return
  await rm(u.storagePath, { force: true })
  await db().update(schema.uploads).set({ consumedAt: new Date() }).where(eq(schema.uploads.id, id))
}

/** Purge des archives jamais utilisées. */
export async function purgeStaleUploads(maxAgeHours = 24): Promise<number> {
  const cutoff = new Date(Date.now() - maxAgeHours * 3600_000)
  const stale = await db().select().from(schema.uploads).where(and(isNull(schema.uploads.consumedAt), lt(schema.uploads.createdAt, cutoff)))
  for (const u of stale) {
    await rm(u.storagePath, { force: true })
    await db().update(schema.uploads).set({ consumedAt: new Date() }).where(eq(schema.uploads.id, u.id))
  }
  return stale.length
}
