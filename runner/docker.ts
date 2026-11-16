/**
 * Accès contrôlé au moteur Docker local (socket Unix) pour le build (§8).
 * Seules deux opérations existent : construire une image à partir d'un
 * contexte situé dans les racines, et supprimer des images `platform/…`.
 */
import { request } from 'node:http'
import { posix } from 'node:path'
import { Readable } from 'node:stream'
import { pack } from 'tar-stream'
import { PathViolation } from '../server/utils/path-guard'
import { BuildTrace, buildkitUnavailable } from './buildkit'
import { type HostFs, entryPath, localFs } from './host-fs'
import { trimTrailingSlashes } from '../shared/utils/trim'

export interface DockerBuildOptions {
  contextDir: string
  dockerfile: string
  tag: string
  buildArgs: Record<string, string>
  labels: Record<string, string>
  target?: string | null
  memoryMb?: number
  cpuQuota?: number
  timeoutMs: number
  maxLogBytes: number
  /** Récupère à nouveau les images de base (FROM). */
  pull?: boolean
  /** Ignore le cache des couches. */
  noCache?: boolean
  /** BuildKit : délai sans aucune progression (après l'envoi du contexte) avant de refaire le build avec le builder classique. */
  buildkitStallMs?: number
  /** BuildKit (étapes en parallèle, cache plus efficace) ; repli sur le builder classique s'il est indisponible. Sans limite mémoire. */
  buildkit?: boolean
  onLog: (line: string, stream: 'stdout' | 'stderr') => void
}

export interface DockerBuildResult { imageId: string, durationMs: number, contextBytes: number }

export class DockerError extends Error {}

/** Délai sans aucune progression d'un build BuildKit (hors envoi du contexte) avant repli sur le builder classique. */
const BUILDKIT_STALL_MS = 60_000

/**
 * Règles .dockerignore, avec la sémantique de Docker (filepath.Match + **) :
 * « * » et « ? » ne traversent pas « / » mais correspondent aux fichiers
 * cachés (contrairement aux globs shell) ; un répertoire exclu exclut son
 * contenu ; la dernière règle applicable l'emporte (« ! » ré-inclut).
 */
export interface IgnoreRule { negate: boolean, re: RegExp }

function patternToRegex(pattern: string): RegExp {
  let re = ''
  let i = 0
  while (i < pattern.length) {
    const c = pattern[i++]!
    if (c === '*') {
      if (pattern[i] === '*') {
        // « **/ » : zéro ou plusieurs répertoires ; « ** » en fin : tout.
        if (pattern[i + 1] === '/') {
          re += '(?:.*/)?'
          i += 2
        }
        else {
          re += '.*'
          i += 1
        }
      }
      else {
        re += '[^/]*'
      }
    }
    else if (c === '?') {
      re += '[^/]'
    }
    else if (c === '[') {
      const end = pattern.indexOf(']', i)
      if (end < 0) re += '\\['
      else {
        const body = pattern.slice(i, end).replace(/^!/, '^').replace(/\\/g, '\\\\')
        re += `[${body}]`
        i = end + 1
      }
    }
    else {
      re += c.replace(/[.+^${}()|\\]/g, m => `\\${m}`)
    }
  }
  return new RegExp(`^${re}$`)
}

export function parseDockerignore(text: string): IgnoreRule[] {
  return text.split('\n').map(l => l.trim()).filter(l => l && !l.startsWith('#')).map((l) => {
    const negate = l.startsWith('!')
    const p = trimTrailingSlashes(posix.normalize((negate ? l.slice(1) : l).trim().replace(/^\/+/, '')))
    return { negate, re: patternToRegex(p) }
  })
}

export function isIgnored(rel: string, rules: IgnoreRule[]): boolean {
  const parts = rel.split('/')
  // Le chemin lui-même et chacun de ses répertoires parents.
  const candidates = parts.map((_, i) => parts.slice(0, i + 1).join('/'))
  let ignored = false
  for (const r of rules) {
    if (candidates.some(c => r.re.test(c))) ignored = !r.negate
  }
  return ignored
}

/** Archive tar du contexte, sans lien symbolique, en respectant .dockerignore (le Dockerfile reste toujours inclus). */
export async function contextTar(contextDir: string, dockerfile: string, fs: HostFs = localFs): Promise<{ stream: NodeJS.ReadableStream, bytes: number }> {
  let rules: IgnoreRule[] = []
  try {
    rules = parseDockerignore((await fs.readFile(posix.join(contextDir, '.dockerignore'))).toString('utf8'))
  }
  catch { /* pas de .dockerignore */ }

  const entries = (await fs.readdir(contextDir, { recursive: true }))
    .map(e => ({ e, full: entryPath(e) }))
    .map(x => ({ ...x, rel: posix.relative(contextDir, x.full) }))
    .sort((a, b) => a.rel.localeCompare(b.rel))

  const tar = pack()
  let bytes = 0
  const files: { rel: string, full: string, size: number, mode: number, mtime: Date }[] = []
  for (const { e, full, rel } of entries) {
    if (e.isSymbolicLink()) throw new PathViolation(full, 'lien symbolique refusé dans le contexte de build')
    if (!e.isFile()) continue
    if (rel !== dockerfile && rel !== '.dockerignore' && isIgnored(rel, rules)) continue
    const st = await fs.lstat(full)
    files.push({ rel, full, size: st.size, mode: st.mode & 0o777, mtime: st.mtime })
    bytes += st.size
  }
  void (async () => {
    try {
      for (const f of files) {
        await new Promise<void>((resolve, reject) => {
          const entry = tar.entry({ name: f.rel, size: f.size, mode: f.mode, mtime: f.mtime }, err => (err ? reject(err) : resolve()))
          fs.createReadStream(f.full).on('error', reject).pipe(entry)
        })
      }
      tar.finalize()
    }
    catch (err) {
      tar.destroy(err as Error)
    }
  })()
  // tar-stream (streamx) est compatible avec pipe() vers un flux Node.
  return { stream: tar as unknown as NodeJS.ReadableStream, bytes }
}

export function createDockerClient(socketPath: string, fs: HostFs = localFs) {
  function call(method: string, path: string, opts: { body?: NodeJS.ReadableStream, headers?: Record<string, string>, signal?: AbortSignal, onSent?: () => void, fresh?: boolean } = {}) {
    return new Promise<import('node:http').IncomingMessage>((resolve, reject) => {
      // fresh : connexion neuve, jamais réutilisée (après un build BuildKit, le moteur ne traite plus correctement une connexion gardée ouverte : un build sur deux se figeait). Les builds en usent toujours, repli classique compris.
      const req = request({ socketPath, method, path, headers: opts.headers, signal: opts.signal, ...(opts.fresh ? { agent: false } : {}) }, resolve)
      req.on('error', reject)
      if (opts.onSent) req.on('finish', opts.onSent)
      if (opts.body) opts.body.pipe(req)
      else req.end()
    })
  }

  async function json<T>(method: string, path: string): Promise<{ status: number, data: T }> {
    const res = await call(method, path)
    let text = ''
    for await (const c of res) text += c
    return { status: res.statusCode ?? 0, data: (text ? JSON.parse(text) : null) as T }
  }

  async function buildOnce(o: DockerBuildOptions): Promise<DockerBuildResult> {
    const started = Date.now()
    const { stream, bytes } = await contextTar(o.contextDir, o.dockerfile, fs)
    const q = new URLSearchParams({
      t: o.tag,
      dockerfile: o.dockerfile,
      buildargs: JSON.stringify(o.buildArgs),
      labels: JSON.stringify(o.labels),
      rm: '1',
      forcerm: '1',
      pull: o.pull ? '1' : '0',
      ...(o.noCache ? { nocache: '1' } : {}),
      networkmode: 'default',
      ...(o.buildkit ? { version: '2' } : {}),
      ...(o.target ? { target: o.target } : {}),
      ...(o.memoryMb && !o.buildkit ? { memory: String(o.memoryMb * 1024 * 1024), memswap: String(o.memoryMb * 1024 * 1024) } : {}),
      ...(o.cpuQuota ? { cpuperiod: '100000', cpuquota: String(Math.round(o.cpuQuota * 100000)) } : {}),
    })
    // BuildKit : sans aucune progression après l'envoi du contexte, le build est abandonné (repli sur le builder classique).
    const stall = new AbortController()
    const stallMs = o.buildkitStallMs ?? BUILDKIT_STALL_MS
    let stallTimer: NodeJS.Timeout | undefined
    // Armé dès l'envoi (le double du délai, pour laisser passer un gros contexte), puis rarmé à la fin de l'envoi du contexte.
    const armStall = (ms: number) => {
      clearTimeout(stallTimer)
      if (o.buildkit) stallTimer = setTimeout(() => stall.abort(), ms)
    }
    armStall(stallMs * 2)
    const signal = AbortSignal.any([AbortSignal.timeout(o.timeoutMs), stall.signal])
    const stalled = () => new DockerError(`BuildKit : aucune progression reçue en ${Math.round(stallMs / 1000)} s après l'envoi du contexte`)
    let res
    try {
      res = await call('POST', `/build?${q}`, { body: stream, headers: { 'content-type': 'application/x-tar' }, signal, onSent: () => armStall(stallMs), fresh: true })
    }
    catch (err) {
      clearTimeout(stallTimer)
      if (stall.signal.aborted) throw stalled()
      // Fermer la connexion annule le build côté Docker.
      if (signal.aborted) throw new DockerError(`Build interrompu : délai de ${Math.round(o.timeoutMs / 1000)} s dépassé`)
      throw new DockerError(`Moteur Docker injoignable : ${(err as Error).message}`)
    }
    let logBytes = 0
    let truncated = false
    let imageId: string | null = null
    let failure: string | null = null
    let buffer = ''
    const emit = (line: string, s: 'stdout' | 'stderr') => {
      if (truncated) return
      logBytes += line.length
      if (logBytes > o.maxLogBytes) {
        truncated = true
        o.onLog(`[logs tronqués au-delà de ${Math.round(o.maxLogBytes / 1024)} Ko ; le build continue]`, 'stderr')
        return
      }
      o.onLog(line, s)
    }
    // BuildKit : la progression arrive en messages protobuf, traduits en lignes de log.
    const trace = new BuildTrace((line, s) => emit(line, s))
    if (o.buildkit) o.onLog('BuildKit : limite mémoire du build non appliquée (réglage du démon BuildKit)', 'stdout')
    try {
      for await (const chunk of res) {
        clearTimeout(stallTimer)
        buffer += chunk
        let nl
        while ((nl = buffer.indexOf('\n')) >= 0) {
          const raw = buffer.slice(0, nl).trim()
          buffer = buffer.slice(nl + 1)
          if (!raw) continue
          let msg: { id?: string, stream?: string, error?: string, errorDetail?: { message?: string }, aux?: { ID?: string } | string, status?: string }
          try {
            msg = JSON.parse(raw)
          }
          catch {
            emit(raw, 'stdout')
            continue
          }
          if (msg.error || msg.errorDetail) {
            failure = msg.errorDetail?.message ?? msg.error ?? 'erreur inconnue'
            emit(failure, 'stderr')
          }
          if (typeof msg.aux === 'string') {
            if (msg.id === 'moby.buildkit.trace') trace.feed(msg.aux)
            continue
          }
          if (msg.aux?.ID) imageId = msg.aux.ID
          for (const l of (msg.stream ?? msg.status ?? '').split('\n')) if (l.trimEnd()) emit(l.trimEnd(), 'stdout')
        }
      }
    }
    catch (err) {
      clearTimeout(stallTimer)
      if (stall.signal.aborted) throw stalled()
      if (signal.aborted) throw new DockerError(`Build interrompu : délai de ${Math.round(o.timeoutMs / 1000)} s dépassé`)
      throw new DockerError(`Flux de build interrompu : ${(err as Error).message}`)
    }
    clearTimeout(stallTimer)
    trace.flush()
    if (res.statusCode !== 200) throw new DockerError(`Docker a refusé le build (${res.statusCode}) ${failure ?? ''}`.trim())
    if (failure) throw new DockerError(`Échec du build : ${failure}`)
    if (!imageId) {
      const inspect = await json<{ Id?: string }>('GET', `/images/${encodeURIComponent(o.tag)}/json`)
      imageId = inspect.data?.Id ?? null
    }
    if (!imageId) throw new DockerError('Build terminé sans image produite')
    return { imageId, durationMs: Date.now() - started, contextBytes: bytes }
  }

  return {
    async ping(): Promise<boolean> {
      try {
        const res = await call('GET', '/_ping')
        res.resume()
        return res.statusCode === 200
      }
      catch {
        return false
      }
    },

    async build(o: DockerBuildOptions): Promise<DockerBuildResult> {
      if (!o.buildkit) return buildOnce(o)
      try {
        return await buildOnce(o)
      }
      catch (err) {
        if (!(err instanceof DockerError) || !buildkitUnavailable(err.message)) throw err
        o.onLog(`BuildKit indisponible (${err.message.slice(0, 200)}) : nouveau build avec le builder classique`, 'stderr')
        return buildOnce({ ...o, buildkit: false })
      }
    },

    /**
     * Création de répertoires avec les droits du moteur Docker (compte sans droits sur le parent) :
     * conteneur éphémère sans réseau, seul `parent` monté. `mkdirs` et `chowns` sont relatifs à
     * `parent` ; seuls les répertoires listés dans `chowns` changent de propriétaire.
     */
    async prepareDirs(o: { image: string, parent: string, mkdirs: string[], chowns: string[], owner: string, mode: string, timeoutMs?: number }): Promise<void> {
      for (const d of [...o.mkdirs, ...o.chowns]) {
        if (!d || d.startsWith('/') || d.split('/').some(seg => seg === '..' || seg === '.' || seg === '') || /[\n\r\0]/.test(d)) throw new DockerError(`Chemin relatif invalide : ${d}`)
      }
      if (!/^\d+:\d+$/.test(o.owner) || !/^0[0-7]{3}$/.test(o.mode)) throw new DockerError('Propriétaire ou mode invalide')
      // Image d'appoint : téléchargée si absente.
      if ((await json('GET', `/images/${encodeURIComponent(o.image)}/json`)).status === 404) {
        const [fromImage, tag = 'latest'] = o.image.split(/:(?=[^:/]+$)/)
        const res = await call('POST', `/images/create?${new URLSearchParams({ fromImage: fromImage!, tag })}`)
        let text = ''
        for await (const c of res) text += c
        if (res.statusCode !== 200 || /"error"/.test(text)) throw new DockerError(`Image ${o.image} indisponible sur l'hôte (téléchargement refusé ou impossible) : créer les répertoires à la main ou la charger (docker load)`)
      }
      // Chemins passés par l'environnement, un par ligne : aucune interpolation dans le script.
      const script = 'set -eu\nIFS=\'\n\'\nfor d in $MKDIRS; do mkdir -p -m "$MODE" "/w/$d"; done\nfor d in $CHOWNS; do chown "$OWNER" "/w/$d"; done'
      const body = JSON.stringify({
        Image: o.image,
        Cmd: ['sh', '-c', script],
        User: '0:0',
        Env: [`MKDIRS=${o.mkdirs.join('\n')}`, `CHOWNS=${o.chowns.join('\n')}`, `OWNER=${o.owner}`, `MODE=${o.mode}`],
        Labels: { 'platform.managed': 'true', 'platform.role': 'prepare-dirs' },
        HostConfig: { Binds: [`${o.parent}:/w`], NetworkMode: 'none', AutoRemove: false },
      })
      const created = await call('POST', '/containers/create', { body: Readable.from([body]), headers: { 'Content-Type': 'application/json' } })
      let text = ''
      for await (const c of created) text += c
      if (created.statusCode !== 201) throw new DockerError(`Conteneur de préparation refusé (${created.statusCode}) : ${text.slice(0, 200)}`)
      const id = (JSON.parse(text) as { Id: string }).Id
      try {
        const started = await json('POST', `/containers/${id}/start`)
        if (started.status >= 300) throw new DockerError(`Démarrage du conteneur de préparation refusé (${started.status})`)
        const signal = AbortSignal.timeout(o.timeoutMs ?? 60_000)
        const res = await call('POST', `/containers/${id}/wait`, { signal })
        let w = ''
        for await (const c of res) w += c
        const code = (JSON.parse(w || '{}') as { StatusCode?: number }).StatusCode
        if (code !== 0) {
          const logs = await call('GET', `/containers/${id}/logs?stdout=1&stderr=1&tail=5`)
          let l = ''
          for await (const c of logs) l += c
          // Flux multiplexé : octets de contrôle retirés pour le message.
          // eslint-disable-next-line no-control-regex
          throw new DockerError(`Création des répertoires impossible : ${l.replace(/[\u0000-\u0008\u000e-\u001f]/g, '').trim().slice(0, 300) || `code ${code}`}`)
        }
      }
      finally {
        await json('DELETE', `/containers/${id}?force=1`).catch(() => {})
      }
    },

    /** Suppression d'images de la plateforme uniquement (préfixe platform/). */
    async removeImages(tags: string[]): Promise<{ removed: string[], missing: string[], failed: { tag: string, reason: string }[] }> {
      for (const tag of tags) {
        if (!/^platform\/[a-z0-9][a-z0-9._-]*:[A-Za-z0-9._-]{1,128}$/.test(tag)) throw new PathViolation(tag, 'seules les images platform/… peuvent être supprimées')
      }
      const removed: string[] = []
      const missing: string[] = []
      const failed: { tag: string, reason: string }[] = []
      for (const tag of tags) {
        const r = await json<{ message?: string }>('DELETE', `/images/${encodeURIComponent(tag)}`)
        if (r.status === 404) missing.push(tag)
        else if (r.status >= 400) failed.push({ tag, reason: r.data?.message ?? `HTTP ${r.status}` })
        else removed.push(tag)
      }
      return { removed, missing, failed }
    },
  }
}

export type DockerClient = ReturnType<typeof createDockerClient>
