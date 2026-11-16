/**
 * Implémentation des actions de la liste blanche (§4). Aucune n'exécute de
 * commande shell : uniquement des appels système de fichiers contrôlés, sur le
 * disque local (Runner) ou par SFTP (hôte joint en SSH).
 */
import { createHash } from 'node:crypto'
import { dirname, posix } from 'node:path'
import { Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import type { Readable } from 'node:stream'
import type { RunnerInput } from '../server/adapters/runner/types'
import { PathViolation, isWithin, validateRelativeEntry } from '../server/utils/path-guard'
import type { FsGuard } from './fs-guard'
import { type HostFs, entryPath, localFs } from './host-fs'

export class RunnerError extends Error {
  constructor(message: string, public readonly status: number) {
    super(message)
    this.name = 'RunnerError'
  }
}

export function createActions(guard: FsGuard, opts: { maxUploadBytes: number }, fs: HostFs = localFs) {
  async function exists(p: string): Promise<boolean> {
    try {
      await fs.lstat(p)
      return true
    }
    catch {
      return false
    }
  }

  /** Taille totale et vérification qu'aucun lien symbolique n'est présent. */
  async function treeStats(dir: string): Promise<{ bytes: number, files: number }> {
    let bytes = 0
    let files = 0
    for (const e of await fs.readdir(dir, { recursive: true })) {
      const full = entryPath(e)
      if (e.isSymbolicLink()) throw new PathViolation(full, 'lien symbolique refusé')
      if (e.isFile()) {
        bytes += (await fs.stat(full)).size
        files++
      }
    }
    return { bytes, files }
  }

  return {
    async checkDir(input: RunnerInput<'checkDir'>) {
      const p = await guard.resolve(input.path, { allowRoot: true })
      try {
        const st = await fs.stat(p)
        return { exists: true, isDirectory: st.isDirectory(), writable: st.isDirectory() ? await fs.writable(p) : false }
      }
      catch {
        return { exists: false, isDirectory: false, writable: false }
      }
    },

    async ensureDir(input: RunnerInput<'ensureDir'>) {
      const p = await guard.resolve(input.path, { allowRoot: true })
      const mode = Number.parseInt(input.mode, 8)
      // Création niveau par niveau pour appliquer mode et propriétaire à chaque répertoire créé.
      const root = guard.rootOf(p)!
      const parts = posix.relative(root, p).split('/').filter(Boolean)
      let current = root
      if (!(await exists(root))) throw new RunnerError(`Racine absente sur l'hôte : ${root}`, 409)
      for (const part of parts) {
        current = posix.join(current, part)
        if (await exists(current)) {
          if (!(await fs.lstat(current)).isDirectory()) throw new RunnerError(`${current} existe et n'est pas un répertoire`, 409)
          continue
        }
        await fs.mkdir(current, mode)
        await fs.chmod(current, mode)
        if (input.uid !== undefined || input.gid !== undefined) await fs.chown(current, input.uid ?? -1, input.gid ?? -1)
      }
    },

    async pathExists(input: RunnerInput<'pathExists'>) {
      const p = await guard.resolve(input.path, { allowRoot: true })
      return { exists: await exists(p) }
    },

    /** Dépôt en flux : taille et SHA-256 vérifiés, écriture dans un fichier temporaire puis renommage. */
    async uploadFile(input: RunnerInput<'uploadFile'>, body: Readable) {
      const p = await guard.resolve(input.path)
      if (input.sizeBytes > opts.maxUploadBytes) throw new RunnerError(`Fichier supérieur à ${Math.round(opts.maxUploadBytes / 1024 / 1024)} Mo`, 413)
      if (await exists(p)) throw new RunnerError(`Le fichier existe déjà : ${p}`, 409)
      await guard.resolve(dirname(p), { allowRoot: true })
      const tmp = `${p}.upload-${process.pid}-${Date.now()}`
      const hash = createHash('sha256')
      let received = 0
      const meter = new Transform({
        transform(chunk: Buffer, _e, cb) {
          received += chunk.length
          if (received > input.sizeBytes) return cb(new RunnerError('Taille reçue supérieure à la taille annoncée', 400))
          hash.update(chunk)
          cb(null, chunk)
        },
      })
      try {
        await pipeline(body, meter, fs.createWriteStream(tmp, 0o640))
        if (received !== input.sizeBytes) throw new RunnerError(`Taille reçue (${received}) différente de la taille annoncée (${input.sizeBytes})`, 400)
        if (hash.digest('hex') !== input.sha256) throw new RunnerError('Empreinte SHA-256 invalide : fichier corrompu ou altéré', 400)
        await fs.rename(tmp, p)
      }
      catch (err) {
        await fs.rmrf(tmp).catch(() => {})
        throw err
      }
    },

    async extractArchive(input: RunnerInput<'extractArchive'>) {
      const archive = await guard.resolve(input.archivePath)
      const dest = await guard.resolve(input.destination)
      if (await exists(dest)) {
        // Un répertoire vide (emplacement d'un sous-module) peut être remplacé ; rien d'autre.
        const st = await fs.lstat(dest)
        if (!st.isDirectory() || (await fs.readdir(dest)).length > 0) throw new RunnerError(`La destination existe déjà : ${dest}`, 409)
        await fs.rmdir(dest)
      }
      await guard.resolve(dirname(dest), { allowRoot: true })
      return fs.extractZip(archive, dest, { maxFiles: input.maxFiles, maxTotalBytes: input.maxTotalBytes, timeoutMs: input.timeoutSec * 1000, stripPrefix: input.stripPrefix })
    },

    /** Empreinte déterministe d'une arborescence : chemins relatifs triés + contenu. */
    async hashTree(input: RunnerInput<'hashTree'>) {
      const p = await guard.resolve(input.path)
      const entries = (await fs.readdir(p, { recursive: true }))
        .map(e => ({ e, full: entryPath(e) }))
        .sort((a, b) => a.full.localeCompare(b.full))
      const h = createHash('sha256')
      let files = 0
      for (const { e, full } of entries) {
        if (e.isSymbolicLink()) throw new PathViolation(full, 'lien symbolique refusé')
        if (!e.isFile()) continue
        h.update(posix.relative(p, full)).update('\0')
        await pipeline(fs.createReadStream(full), new Transform({ transform: (c, _e, cb) => { h.update(c); cb() } }))
        h.update('\0')
        files++
      }
      return { sha256: h.digest('hex'), files }
    },

    async prepareBuildContext(input: RunnerInput<'prepareBuildContext'>) {
      const sub = input.subdirectory ? validateRelativeEntry(input.subdirectory) : ''
      const sourceBase = await guard.resolve(input.sourceDir)
      const source = await guard.resolve(posix.join(sourceBase, sub))
      const target = await guard.resolve(input.contextDir)
      if (!isWithin(source, sourceBase)) throw new PathViolation(source, 'sous-répertoire hors des sources')
      if (await exists(target)) throw new RunnerError(`Le contexte existe déjà : ${target}`, 409)
      const { bytes } = await treeStats(source)
      if (bytes > input.maxContextBytes) throw new RunnerError(`Contexte de build trop volumineux (${Math.round(bytes / 1024 / 1024)} Mo)`, 413)
      // Contrôle préalable (aucun lien symbolique) : rien n'est suivi ni copié hors des sources.
      await fs.copyTree(source, target)
      return { sizeBytes: bytes }
    },

    async writeFile(input: RunnerInput<'writeFile'>) {
      const p = await guard.resolve(input.path)
      await guard.resolve(dirname(p), { allowRoot: true })
      if ((await exists(p)) && (await fs.lstat(p)).isSymbolicLink()) throw new PathViolation(p, 'lien symbolique refusé')
      await fs.writeFile(p, input.content, Number.parseInt(input.mode, 8))
      return { sha256: createHash('sha256').update(input.content).digest('hex') }
    },

    async diskUsage(input: RunnerInput<'diskUsage'>) {
      const p = await guard.resolve(input.path, { allowRoot: true })
      return fs.statfs(p)
    },

    /**
     * Suppression d'un sous-arbre (jamais d'une racine). Avec olderThanSec,
     * seuls les enfants directs plus anciens sont supprimés (purge de tmp/).
     */
    async cleanup(input: RunnerInput<'cleanup'>) {
      const p = await guard.resolve(input.path, { allowRoot: input.olderThanSec !== undefined })
      if (!(await exists(p))) return { removedBytes: 0 }
      const targets: string[] = []
      if (input.olderThanSec === undefined) {
        targets.push(p)
      }
      else {
        const limit = Date.now() - input.olderThanSec * 1000
        for (const e of await fs.readdir(p)) {
          const full = posix.join(p, e.name)
          if ((await fs.lstat(full)).mtime.getTime() < limit) targets.push(full)
        }
      }
      let removedBytes = 0
      for (const t of targets) {
        const st = await fs.lstat(t)
        removedBytes += st.isDirectory() ? (await treeStats(t).catch(() => ({ bytes: 0 }))).bytes : st.size
        await fs.rmrf(t)
      }
      return { removedBytes }
    },
  }
}

export type RunnerActions = ReturnType<typeof createActions>
