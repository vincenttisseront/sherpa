/**
 * Système de fichiers de l'hôte vu par les actions du Runner : disque local
 * (Runner installé sur l'hôte) ou SFTP (hôte joint en SSH, sans Runner).
 * Les actions, le garde-fou de chemins et le contexte de build n'utilisent que
 * cette interface : mêmes contrôles (racines, liens symboliques, tailles,
 * empreintes) quel que soit le transport.
 */
import { createReadStream, createWriteStream } from 'node:fs'
import { access, chmod, chown, constants, cp, lstat, mkdir, readFile, readdir, rename, rm, rmdir, stat, statfs, writeFile } from 'node:fs/promises'
import { posix } from 'node:path'
import type { Readable, Writable } from 'node:stream'
import { type ZipLimits, type ZipReport, extractZip } from '../server/lib/zip'

export interface HostStat {
  size: number
  /** Bits de permission et de type (st_mode). */
  mode: number
  mtime: Date
  isFile(): boolean
  isDirectory(): boolean
  isSymbolicLink(): boolean
}

export interface HostDirent {
  name: string
  /** Répertoire contenant l'entrée. */
  parentPath: string
  isFile(): boolean
  isDirectory(): boolean
  isSymbolicLink(): boolean
}

export interface HostFs {
  lstat(path: string): Promise<HostStat>
  stat(path: string): Promise<HostStat>
  /** Entrées d'un répertoire ; récursif : sans suivre les liens symboliques. */
  readdir(path: string, opts?: { recursive?: boolean }): Promise<HostDirent[]>
  mkdir(path: string, mode: number): Promise<void>
  chmod(path: string, mode: number): Promise<void>
  chown(path: string, uid: number, gid: number): Promise<void>
  /** Suppression récursive, sans erreur si absent. */
  rmrf(path: string): Promise<void>
  rmdir(path: string): Promise<void>
  rename(from: string, to: string): Promise<void>
  /** L'utilisateur peut-il écrire dans ce répertoire ? */
  writable(path: string): Promise<boolean>
  statfs(path: string): Promise<{ totalBytes: number, freeBytes: number }>
  readFile(path: string): Promise<Buffer>
  writeFile(path: string, content: string, mode: number): Promise<void>
  createReadStream(path: string): Readable
  /** Création exclusive (échec si le fichier existe). */
  createWriteStream(path: string, mode: number): Writable
  /** Copie d'arborescence sans lien symbolique (vérifiée au préalable), destination absente. */
  copyTree(source: string, target: string): Promise<void>
  /** Extraction d'une archive zip de l'hôte vers une destination absente, avec les limites données. */
  extractZip(archive: string, destination: string, limits: ZipLimits): Promise<ZipReport>
  /** Erreur « fichier absent » de cette implémentation. */
  isNotFound(err: unknown): boolean
}

export const localFs: HostFs = {
  lstat: p => lstat(p),
  stat: p => stat(p),
  async readdir(p, opts) {
    const entries = await readdir(p, { withFileTypes: true, recursive: !!opts?.recursive })
    return entries.map(e => Object.assign(e, { parentPath: e.parentPath ?? p }))
  },
  async mkdir(p, mode) {
    await mkdir(p, { mode })
  },
  chmod: (p, mode) => chmod(p, mode),
  chown: (p, uid, gid) => chown(p, uid, gid),
  rmrf: p => rm(p, { recursive: true, force: true }),
  rmdir: p => rmdir(p),
  rename: (a, b) => rename(a, b),
  async writable(p) {
    try {
      await access(p, constants.W_OK)
      return true
    }
    catch {
      return false
    }
  },
  async statfs(p) {
    const s = await statfs(p)
    return { totalBytes: s.blocks * s.bsize, freeBytes: s.bavail * s.bsize }
  },
  readFile: p => readFile(p),
  writeFile: (p, content, mode) => writeFile(p, content, { mode }),
  createReadStream: p => createReadStream(p),
  createWriteStream: (p, mode) => createWriteStream(p, { flags: 'wx', mode }),
  // verbatimSymlinks + contrôle préalable : aucun lien n'est suivi ni copié.
  copyTree: (source, target) => cp(source, target, { recursive: true, errorOnExist: true, force: false, verbatimSymlinks: true }),
  extractZip: (archive, destination, limits) => extractZip(archive, destination, limits),
  isNotFound: err => (err as NodeJS.ErrnoException)?.code === 'ENOENT',
}

/** Chemin complet d'une entrée de readdir. */
export const entryPath = (e: HostDirent) => posix.join(e.parentPath, e.name)
