/**
 * Target Runner d'un hôte joint en SSH, sans Runner installé : exactement les
 * actions du Runner (même code : garde-fou de chemins, liens symboliques
 * refusés, limites, empreintes, build), exécutées par SFTP et par l'API Docker
 * relayée en SSH. Les racines autorisées sont celles déclarées pour l'endpoint
 * dans la plateforme (onglet Chemins), seule source de vérité en l'absence de
 * Runner sur l'hôte.
 */
import { randomBytes } from 'node:crypto'
import { posix } from 'node:path'
import { Readable } from 'node:stream'
import type { SFTPWrapper } from 'ssh2'
import { ZodError } from 'zod'
import { createActions, RunnerError } from '../../../runner/actions'
import { DockerError, createDockerClient } from '../../../runner/docker'
import { FsGuard } from '../../../runner/fs-guard'
import { ZipRejected } from '../../lib/zip'
import { PathViolation, validateRelativeEntry } from '../../utils/path-guard'
import { PortainerError, type SshConnection } from '../portainer/types'
import { createSftpFs } from '../ssh/sftp-fs'
import { sshDockerSocket, sshSftp } from '../ssh/session'
import { RunnerHttpError, kindFor } from './http'
import { type RunnerAction, type TargetRunner, runnerActions } from './types'

export const SSH_RUNNER_VERSION = 'ssh'
const FS_ACTIONS: RunnerAction[] = ['checkDir', 'ensureDir', 'uploadFile', 'extractArchive', 'hashTree', 'prepareBuildContext', 'diskUsage', 'writeFile', 'cleanup', 'pathExists']
const DOCKER_ACTIONS: RunnerAction[] = ['build', 'removeImages']
const MAX_UPLOAD_BYTES = 2048 * 1024 * 1024
const BUILD_MAX_MEMORY_MB = 4096
/** Builds avec BuildKit (RUNNER_BUILDKIT de la console, comme pour le Runner) : sans limite mémoire par build, repli sur le builder classique. */
const BUILDKIT = /^(1|true|yes|on)$/i.test(process.env.RUNNER_BUILDKIT ?? '')
/** Image d'appoint pour créer, avec les droits du moteur Docker, les répertoires que le compte SSH ne peut pas créer. */
const HELPER_IMAGE = process.env.HOST_HELPER_IMAGE || 'busybox:1.37'
const SFTP_PERMISSION_DENIED = 3

type RawStat = { uid: number, gid: number, mode: number, isDirectory: () => boolean, isSymbolicLink: () => boolean }
const sftpCall = <T>(fn: (cb: (err: Error | null | undefined, v?: T) => void) => void) => new Promise<T>((resolve, reject) => fn((err, v) => (err ? reject(err) : resolve(v as T))))

/**
 * Identité du compte SSH : propriétaire d'un fichier témoin créé dans /tmp (exact), à défaut celui
 * du répertoire personnel (parfois root). Propriétaire des répertoires créés pour lui.
 */
async function whoAmI(sftp: SFTPWrapper): Promise<{ uid: number, gid: number }> {
  const probe = `/tmp/.platform-whoami-${randomBytes(6).toString('hex')}`
  try {
    const handle = await sftpCall<Buffer>(cb => sftp.open(probe, 'wx', 0o600, cb))
    try {
      const st = await sftpCall<RawStat>(cb => sftp.fstat(handle, cb))
      return { uid: st.uid, gid: st.gid }
    }
    finally {
      await sftpCall(cb => sftp.close(handle, cb)).catch(() => {})
      await sftpCall(cb => sftp.unlink(probe, cb)).catch(() => {})
    }
  }
  catch {
    const st = await sftpCall<RawStat>(cb => sftp.stat('.', cb))
    return { uid: st.uid, gid: st.gid }
  }
}

/** État d'accès lisible : compte, chemin et parent (propriétaire, mode), pour le journal. */
export async function explainAccess(sftp: SFTPWrapper, me: { uid: number, gid: number }, path: string): Promise<string> {
  const describe = async (p: string) => {
    const st = await sftpCall<RawStat>(cb => sftp.lstat(p, cb)).catch(() => null)
    if (!st) return `${p} absent`
    const kind = st.isSymbolicLink() ? 'lien' : st.isDirectory() ? 'répertoire' : 'fichier'
    return `${p} : ${kind}, propriétaire ${st.uid}:${st.gid}, mode ${(st.mode & 0o7777).toString(8).padStart(4, '0')}`
  }
  const parts = [`compte SSH uid ${me.uid}, gid ${me.gid}`, await describe(path)]
  if (posix.dirname(path) !== path) parts.push(`parent ${await describe(posix.dirname(path))}`)
  return parts.join(' ; ')
}

/** Refus SFTP (droits) : chemin, compte SSH et correction à appliquer sur l'hôte. */
export function sftpPermissionMessage(path: string | undefined, user: string): string {
  if (!path) return `Permission refusée par le système de fichiers pour le compte SSH ${user}`
  return `Permission refusée sur ${path} pour le compte SSH ${user} : lui donner les droits sur les répertoires de l'onglet Chemins, par ex. sudo chown -R ${user}: <répertoire> (ou setfacl -R -m u:${user}:rwX)`
}

/** Mêmes statuts et catégories d'erreur que le Runner HTTP. */
function asRunnerError(err: unknown, user: string): Error {
  if (err instanceof RunnerHttpError) return err
  const status
    = err instanceof RunnerError ? err.status
      : err instanceof PathViolation ? 403
        : err instanceof ZipRejected ? 422
          : err instanceof ZodError ? 400
            : (err as { code?: number }).code === 3 ? 403
                : null
  if (err instanceof PortainerError) return new RunnerHttpError(err.message, null, err.kind === 'auth' ? 'auth' : 'network')
  if (err instanceof DockerError) return new RunnerHttpError(err.message, 500, 'server')
  if (status) {
    const message = err instanceof ZodError ? `Paramètres invalides : ${err.issues.map(i => `${i.path.join('.')} ${i.message}`).join(' ; ')}` : status === 403 && !(err instanceof PathViolation) && !(err instanceof RunnerError) ? sftpPermissionMessage((err as { path?: string }).path, user) : (err as Error).message
    return new RunnerHttpError(message, status, kindFor(status))
  }
  return new RunnerHttpError(`Erreur SSH/SFTP : ${(err as Error).message ?? 'inconnue'}`.slice(0, 500), 500, 'server')
}

export function createSshRunner(ssh: SshConnection, roots: readonly string[]): TargetRunner {
  const tools = (async () => {
    const sftp = await sshSftp(ssh)
    const fs = createSftpFs(sftp)
    const guard = new FsGuard(roots, fs)
    const me = await whoAmI(sftp)
    return { sftp, fs, guard, me, actions: createActions(guard, { maxUploadBytes: MAX_UPLOAD_BYTES }, fs), docker: createDockerClient(await sshDockerSocket(ssh), fs) }
  })()
  tools.catch(() => {})
  const run = async <T>(fn: (t: Awaited<typeof tools>) => Promise<T>): Promise<T> => {
    try {
      return await fn(await tools)
    }
    catch (err) {
      const e = asRunnerError(err, ssh.username)
      // Refus de droits : état du compte, du chemin et de son parent joint au message (journal du déploiement).
      const path = (err as { path?: string }).path
      if (path && (e as RunnerHttpError).status === 403 && !(err instanceof PathViolation)) {
        const detail = await tools.then(t => explainAccess(t.sftp, t.me, path)).catch(() => null)
        if (detail) e.message = `${e.message} — ${detail}`
      }
      throw e
    }
  }

  /**
   * Répertoire que le compte SSH ne peut pas créer (parent appartenant à root) : créé par un
   * conteneur éphémère (droits du moteur Docker, accessibles à ce compte), puis attribué au compte.
   * Seuls les répertoires créés, et une racine configurée existante, changent de propriétaire :
   * jamais un répertoire existant d'un projet ou de l'utilisateur.
   */
  async function createWithDocker(t: Awaited<typeof tools>, p: string, mode: string, owner: string, claim: boolean): Promise<void> {
    let parent = p
    const missing: string[] = []
    for (;;) {
      const st = await t.fs.lstat(parent).catch(() => null)
      if (st?.isSymbolicLink()) throw new PathViolation(parent, 'lien symbolique refusé')
      if (st) {
        if (!st.isDirectory()) throw new RunnerError(`${parent} existe et n'est pas un répertoire`, 409)
        break
      }
      missing.unshift(posix.basename(parent))
      parent = posix.dirname(parent)
    }
    let mkdirs: string[] = []
    let chowns: string[]
    if (missing.length) {
      mkdirs = [missing.join('/')]
      chowns = missing.map((_, i) => missing.slice(0, i + 1).join('/'))
    }
    else if (claim) {
      // Racine configurée ou répertoire de la plateforme existant mais fermé au compte : lui seul est attribué.
      chowns = [posix.basename(p)]
      parent = posix.dirname(p)
    }
    else {
      throw Object.assign(new Error('permission'), { code: SFTP_PERMISSION_DENIED, path: p })
    }
    const fail = (message: string) => Object.assign(new RunnerError(message, 403), { path: p })
    if (!(await t.docker.ping())) throw fail(`${sftpPermissionMessage(p, ssh.username)} (création automatique impossible : socket Docker inaccessible au compte SSH)`)
    try {
      await t.docker.prepareDirs({ image: HELPER_IMAGE, parent, mkdirs, chowns, owner, mode })
    }
    catch (err) {
      throw fail(`${p} : création automatique par Docker impossible (${(err as Error).message})`)
    }
    if (!(await t.fs.writable(p))) throw fail(`${p} préparé (propriétaire ${owner}) mais toujours fermé au compte SSH ${ssh.username} : propriétaire forcé dans l'onglet Chemins, ou Docker d'un autre hôte que sshd ?`)
  }

  return {
    health: () => run(async t => ({ version: SSH_RUNNER_VERSION, actions: [...FS_ACTIONS, ...(await t.docker.ping() ? DOCKER_ACTIONS : [])], roots: [...roots], hostname: `${ssh.username}@${ssh.host}` })),
    checkDir: (_ctx, input) => run(t => t.actions.checkDir(runnerActions.checkDir.parse(input))),
    ensureDir: (_ctx, raw) => run(async (t) => {
      const input = runnerActions.ensureDir.parse(raw)
      const p = await t.guard.resolve(input.path, { allowRoot: true })
      const mode = Number.parseInt(input.mode, 8)
      const isRoot = roots.includes(p)
      const claim = isRoot || !!input.claim
      try {
        // Les racines sont ici les répertoires configurés eux-mêmes (pas de racine plus large déclarée
        // sur l'hôte) : un répertoire configuré absent est créé, parents compris (création automatique).
        if (isRoot && !(await t.fs.lstat(p).then(() => true, () => false))) {
          let current = ''
          for (const part of p.split('/').filter(Boolean)) {
            current += `/${part}`
            const st = await t.fs.lstat(current).catch(() => null)
            if (st?.isSymbolicLink()) throw new PathViolation(current, 'lien symbolique refusé')
            if (st && !st.isDirectory()) throw new RunnerError(`${current} existe et n'est pas un répertoire`, 409)
            if (!st) await t.fs.mkdir(current, mode)
          }
          await t.fs.chmod(p, mode)
          if (input.uid !== undefined || input.gid !== undefined) await t.fs.chown(p, input.uid ?? -1, input.gid ?? -1)
          return
        }
        await t.actions.ensureDir(input)
        // Racine ou répertoire de la plateforme présent mais fermé au compte SSH (créé par root) : reprise ci-dessous.
        if (claim && !(await t.fs.writable(p))) throw Object.assign(new Error('non accessible en écriture'), { code: SFTP_PERMISSION_DENIED, path: p })
      }
      catch (err) {
        if ((err as { code?: number }).code !== SFTP_PERMISSION_DENIED) throw err
        await createWithDocker(t, p, input.mode, `${input.uid ?? t.me.uid}:${input.gid ?? t.me.gid}`, claim)
      }
    }),
    uploadFile: (_ctx, input, data) => run(t => t.actions.uploadFile(runnerActions.uploadFile.parse(input), Readable.from(data))),
    extractArchive: (_ctx, input) => run(t => t.actions.extractArchive(runnerActions.extractArchive.parse(input))),
    hashTree: (_ctx, input) => run(t => t.actions.hashTree(runnerActions.hashTree.parse(input))),
    prepareBuildContext: (_ctx, input) => run(t => t.actions.prepareBuildContext(runnerActions.prepareBuildContext.parse(input))),
    diskUsage: (_ctx, input) => run(t => t.actions.diskUsage(runnerActions.diskUsage.parse(input))),
    writeFile: (_ctx, input) => run(t => t.actions.writeFile(runnerActions.writeFile.parse(input))),
    pathExists: (_ctx, input) => run(t => t.actions.pathExists(runnerActions.pathExists.parse(input))),
    cleanup: (_ctx, input) => run(t => t.actions.cleanup(runnerActions.cleanup.parse(input))),
    removeImages: (_ctx, input) => run(t => t.docker.removeImages(runnerActions.removeImages.parse(input).tags)),
    build: (_ctx, raw, onLog) => run(async (t) => {
      const input = runnerActions.build.parse(raw)
      const contextDir = await t.guard.resolve(input.contextDir)
      const dockerfile = validateRelativeEntry(input.dockerfile)
      const r = await t.docker.build({
        contextDir,
        dockerfile,
        tag: input.imageTag,
        buildArgs: input.buildArgs,
        labels: { ...input.labels, 'platform.managed': 'true' },
        target: input.target,
        memoryMb: Math.min(input.memoryMb ?? BUILD_MAX_MEMORY_MB, BUILD_MAX_MEMORY_MB),
        cpuQuota: input.cpuQuota,
        timeoutMs: input.timeoutSec * 1000,
        maxLogBytes: input.maxLogBytes,
        pull: input.pull,
        noCache: input.noCache,
        buildkit: BUILDKIT,
        onLog: (line, stream) => onLog({ ts: new Date().toISOString(), stream, line }),
      })
      return { imageId: r.imageId, imageTag: input.imageTag, durationMs: r.durationMs, contextBytes: r.contextBytes }
    }),
  }
}
