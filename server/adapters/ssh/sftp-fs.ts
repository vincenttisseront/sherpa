/**
 * Système de fichiers d'un hôte joint en SSH (SFTP), pour les actions du Runner
 * exécutées sans Runner : mêmes contrôles que sur le disque local (garde-fou de
 * chemins, liens symboliques refusés, limites et empreintes).
 *
 * - Aucune commande shell : uniquement le protocole SFTP (et l'extension
 *   statvfs d'OpenSSH pour l'espace disque).
 * - Les entrées de répertoire SFTP décrivent l'entrée elle-même (lstat) :
 *   les liens symboliques ne sont jamais traversés.
 * - Une archive est contrôlée et extraite par la plateforme (mêmes limites que
 *   le Runner), puis déposée dans un répertoire temporaire renommé à la fin.
 */
import { randomBytes } from 'node:crypto'
import { mkdtemp, rm, stat as localStat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, posix } from 'node:path'
import type { Readable, Writable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import type { SFTPWrapper, Stats } from 'ssh2'
import { type HostDirent, type HostFs, type HostStat, entryPath, localFs } from '../../../runner/host-fs'

const NO_SUCH_FILE = 2

const toStat = (s: Stats): HostStat => ({
  size: s.size,
  mode: s.mode,
  mtime: new Date(s.mtime * 1000),
  isFile: () => s.isFile(),
  isDirectory: () => s.isDirectory(),
  isSymbolicLink: () => s.isSymbolicLink(),
})

/** Appel SFTP ; en cas d'échec, le chemin concerné est joint à l'erreur (messages exploitables). */
function call<T>(path: string, fn: (cb: (err: Error | null | undefined, v?: T) => void) => void): Promise<T> {
  return new Promise((resolve, reject) => fn((err, v) => (err ? reject(Object.assign(err, { path: (err as { path?: string }).path ?? path })) : resolve(v as T))))
}

export function createSftpFs(sftp: SFTPWrapper): HostFs {
  const lstat = (p: string) => call<Stats>(p, cb => sftp.lstat(p, cb)).then(toStat)
  const stat = (p: string) => call<Stats>(p, cb => sftp.stat(p, cb)).then(toStat)

  async function list(dir: string): Promise<HostDirent[]> {
    const entries = await call<{ filename: string, attrs: Stats }[]>(dir, cb => sftp.readdir(dir, cb))
    return entries
      .filter(e => e.filename !== '.' && e.filename !== '..')
      .map(e => ({ name: e.filename, parentPath: dir, isFile: () => e.attrs.isFile(), isDirectory: () => e.attrs.isDirectory(), isSymbolicLink: () => e.attrs.isSymbolicLink() }))
  }

  async function readdir(p: string, opts?: { recursive?: boolean }): Promise<HostDirent[]> {
    const out: HostDirent[] = []
    const queue = [p]
    while (queue.length) {
      const dir = queue.shift()!
      for (const e of await list(dir)) {
        out.push(e)
        if (opts?.recursive && e.isDirectory() && !e.isSymbolicLink()) queue.push(entryPath(e))
      }
    }
    return out
  }

  async function rmrf(p: string): Promise<void> {
    let st: HostStat
    try {
      st = await lstat(p)
    }
    catch (err) {
      if (isNotFound(err)) return
      throw err
    }
    if (st.isDirectory()) {
      for (const e of await list(p)) await rmrf(entryPath(e))
      await call<undefined>(p, cb => sftp.rmdir(p, cb))
    }
    else {
      await call<undefined>(p, cb => sftp.unlink(p, cb))
    }
  }

  const isNotFound = (err: unknown) => (err as { code?: number })?.code === NO_SUCH_FILE

  const mkdir = (p: string, mode: number) => call<undefined>(p, cb => sftp.mkdir(p, { mode }, cb))
  // Erreurs des flux : chemin joint à l'objet erreur (le même que reçoit pipeline()).
  function tagPath<S extends Readable | Writable>(stream: S, p: string): S {
    stream.on('error', (err: Error & { path?: string }) => {
      err.path ??= p
    })
    return stream
  }
  const createReadStream = (p: string): Readable => tagPath(sftp.createReadStream(p), p)
  const createWriteStream = (p: string, mode: number): Writable => tagPath(sftp.createWriteStream(p, { flags: 'wx', mode }), p)

  /** Dépôt d'une arborescence locale (déjà contrôlée) dans un répertoire distant absent. */
  async function uploadTree(local: string, remote: string): Promise<void> {
    await mkdir(remote, 0o750)
    for (const e of await localFs.readdir(local)) {
      const src = join(local, e.name)
      const dst = posix.join(remote, e.name)
      if (e.isDirectory()) await uploadTree(src, dst)
      else if (e.isFile()) await call<undefined>(dst, cb => sftp.fastPut(src, dst, { mode: 0o640 }, cb))
    }
  }

  return {
    lstat,
    stat,
    readdir,
    mkdir,
    chmod: (p, mode) => call<undefined>(p, cb => sftp.chmod(p, mode, cb)),
    async chown(p, uid, gid) {
      // -1 : inchangé (comme chown(2)) ; SFTP exige les deux identifiants.
      if (uid < 0 || gid < 0) {
        const cur = await call<Stats>(p, cb => sftp.lstat(p, cb))
        uid = uid < 0 ? cur.uid : uid
        gid = gid < 0 ? cur.gid : gid
      }
      await call<undefined>(p, cb => sftp.chown(p, uid, gid, cb))
    },
    rmrf,
    rmdir: p => call<undefined>(p, cb => sftp.rmdir(p, cb)),
    rename: (a, b) => call<undefined>(b, cb => sftp.rename(a, b, cb)),
    async writable(p) {
      // Pas d'access() en SFTP : création exclusive d'un fichier témoin, aussitôt supprimé.
      const probe = posix.join(p, `.platform-write-test-${randomBytes(6).toString('hex')}`)
      try {
        const handle = await call<Buffer>(probe, cb => sftp.open(probe, 'wx', 0o600, cb))
        await call<undefined>(probe, cb => sftp.close(handle, cb))
        await call<undefined>(probe, cb => sftp.unlink(probe, cb))
        return true
      }
      catch {
        return false
      }
    },
    async statfs(p) {
      // Extension statvfs@openssh.com : entiers 64 bits (nombre, bigint ou chaîne selon la taille).
      const s = await call<Record<'f_bsize' | 'f_frsize' | 'f_blocks' | 'f_bavail', number | bigint | string>>(p, cb => sftp.ext_openssh_statvfs(p, cb as never))
      const n = (v: number | bigint | string) => Number(v)
      const unit = n(s.f_frsize) || n(s.f_bsize)
      return { totalBytes: n(s.f_blocks) * unit, freeBytes: n(s.f_bavail) * unit }
    },
    readFile: p => call<Buffer>(p, cb => sftp.readFile(p, cb)),
    writeFile: (p, content, mode) => call<undefined>(p, cb => sftp.writeFile(p, content, { mode }, cb)),
    createReadStream,
    createWriteStream,
    async copyTree(source, target) {
      const st = await lstat(source)
      await mkdir(target, st.mode & 0o777)
      for (const e of (await list(source)).sort((a, b) => a.name.localeCompare(b.name))) {
        const src = entryPath(e)
        const dst = posix.join(target, e.name)
        if (e.isSymbolicLink()) continue
        if (e.isDirectory()) await this.copyTree(src, dst)
        else if (e.isFile()) await pipeline(createReadStream(src), createWriteStream(dst, (await lstat(src)).mode & 0o777))
      }
    },
    async extractZip(archive, destination, limits) {
      const work = await mkdtemp(join(tmpdir(), 'pp-sftp-zip-'))
      const partial = `${destination}.partial-${randomBytes(4).toString('hex')}`
      try {
        const zip = join(work, 'archive.zip')
        await call<undefined>(archive, cb => sftp.fastGet(archive, zip, cb))
        if ((await localStat(zip)).size === 0) throw new Error('Archive vide sur l\'hôte')
        // Mêmes contrôles que le Runner (entrées, tailles, liens, durée), puis dépôt atomique.
        const report = await localFs.extractZip(zip, join(work, 'tree'), limits)
        await uploadTree(join(work, 'tree'), partial)
        await call<undefined>(destination, cb => sftp.rename(partial, destination, cb))
        return report
      }
      catch (err) {
        await rmrf(partial).catch(() => {})
        throw err
      }
      finally {
        await rm(work, { recursive: true, force: true }).catch(() => {})
      }
    },
    isNotFound,
  }
}
