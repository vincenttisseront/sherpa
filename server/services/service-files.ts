/**
 * Explorateur des fichiers d'un service de la stack : montages de son conteneur, contenu d'un
 * dossier, lecture et modification d'un fichier texte. Chaque opération passe par un conteneur
 * ponctuel sans réseau qui ne monte que le montage concerné (en lecture seule hors écriture).
 * Le contenu des fichiers n'est jamais journalisé ni audité (chemin seulement).
 */
import { createHash } from 'node:crypto'
import { posix } from 'node:path'
import { PassThrough, type Readable } from 'node:stream'
import { createReadStream, createWriteStream } from 'node:fs'
import { mkdtemp, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { pipeline } from 'node:stream/promises'
import { ZipLimitError, ZipStream } from '../lib/zip-stream'
import { extract, pack } from 'tar-stream'
import { archiveOf } from '../../shared/utils/image-types'
import { formatBytes } from '../../shared/utils/format'
import { createError } from 'h3'
import type { ServiceFileDto, ServiceFileWrite, ServiceFilesDto, ServiceMountDto } from '../../shared/schemas/service-files'
import { portainer } from '../adapters/portainer'
import { FilePathError, LIST_OUTPUT, MAX_TEXT_BYTES, MAX_UPLOAD_BYTES, copyScript, deleteScript, extractScript, isVersionOf, restoreVersionScript, versionDate, versionsScript, parseSearch, searchScript, mkdirScript, moveScript, permissionsScript, renameScript, validMode, backupScript, backupSuffix, browsableMount, downloadName, safeFileName, uploadCheckScript, listScript, parseList, parseStat, readScript, safeRelPath, statScript, target, writeScript } from '../lib/service-files'
import { stackOfTarget } from './diagnostic'
import type { TargetRow } from './projects'
import { HELPER_IMAGE, sideOf } from './stack-migration'

async function context(t: TargetRow, service: string) {
  const side = await sideOf(t.endpoint.id, t.env.id)
  const conn = await side.conn()
  const epId = t.endpoint.portainerEndpointId
  const stack = stackOfTarget(t)
  const c = (await portainer().listContainers(conn, epId)).find(x => x.labels['com.docker.compose.project'] === stack && x.labels['com.docker.compose.service'] === service)
  if (!c) throw createError({ statusCode: 404, statusMessage: `Aucun conteneur pour le service ${service}` })
  const mounts: (ServiceMountDto & { bind: string })[] = (c.mounts ?? []).filter(browsableMount).map((m) => {
    const source = (m.type === 'volume' ? m.name : m.source)!
    return { destination: m.destination, source, type: m.type as 'volume' | 'bind', writable: m.rw, bind: source }
  }).sort((a, b) => a.destination.localeCompare(b.destination))
  return { conn, epId, container: c, mounts }
}

function rel(path: string): string {
  try {
    return safeRelPath(path)
  }
  catch (err) {
    throw createError({ statusCode: 422, statusMessage: err instanceof FilePathError ? err.message : 'Chemin invalide' })
  }
}

function mountOf<T extends { destination: string }>(mounts: T[], destination: string): T {
  const m = mounts.find(x => x.destination === destination)
  if (!m) throw createError({ statusCode: 404, statusMessage: 'Montage introuvable sur ce service' })
  return m
}

async function run(ctx: Awaited<ReturnType<typeof context>>, bind: string, script: string, opts: { files?: { path: string, content: string }[], outputs?: string[], timeoutMs?: number } = {}) {
  return portainer().runOneShot(ctx.conn, ctx.epId, {
    image: HELPER_IMAGE,
    entrypoint: ['sh', '-c'],
    cmd: [script],
    binds: [bind],
    files: (opts.files ?? []).map(f => ({ ...f, mode: 0o600 })),
    outputs: opts.outputs ?? [],
    outputLimits: { maxBytes: MAX_TEXT_BYTES, maxFiles: 1 },
    labels: { 'platform.managed': 'true', 'platform.role': 'service-files' },
    timeoutMs: opts.timeoutMs ?? 60_000,
    memoryMb: 128,
  })
}

const dto = (e: ReturnType<typeof parseStat> & object) => ({ ...e, mtime: new Date(e.mtime * 1000).toISOString() })
const sha = (s: string) => createHash('sha256').update(s, 'utf8').digest('hex')

export async function listServiceFiles(t: TargetRow, service: string, mount: string | null, path: string): Promise<ServiceFilesDto> {
  const ctx = await context(t, service)
  const base = { service, container: ctx.container.names[0] ?? ctx.container.id.slice(0, 12), running: ctx.container.state === 'running', mounts: ctx.mounts.map(({ bind: _, ...m }) => m) }
  const dest = mount ?? ctx.mounts[0]?.destination ?? null
  if (dest === null) return { ...base, mount: null, path: '', isFile: false, entries: [], truncated: false }
  const m = mountOf(ctx.mounts, dest)
  const r = rel(path)
  const out = await run(ctx, `${m.bind}:/m:ro`, listScript(r), { outputs: [LIST_OUTPUT] })
  const text = out.outputs[LIST_OUTPUT]?.[0]?.content
  if (text === undefined) throw createError({ statusCode: 502, statusMessage: `Lecture de ${posix.join(m.destination, r)} impossible${out.logs.length ? ` : ${out.logs.at(-1)}` : ''}` })
  const list = parseList(text.split('\n'))
  if (list.state === 'none') throw createError({ statusCode: 404, statusMessage: `${posix.join(m.destination, r)} : introuvable` })
  return { ...base, mount: dest, path: r, isFile: list.state === 'file', entries: list.entries.map(dto), truncated: list.truncated }
}

export async function readServiceFile(t: TargetRow, service: string, mount: string, path: string): Promise<ServiceFileDto> {
  const ctx = await context(t, service)
  const m = mountOf(ctx.mounts, mount)
  const r = rel(path)
  const out = await run(ctx, `${m.bind}:/m:ro`, readScript(r), { outputs: ['/tmp/out'] })
  const lines = out.logs.map(l => l.trimEnd())
  if (lines.includes('@@LINK')) throw createError({ statusCode: 422, statusMessage: 'Lien symbolique : ouvrir le fichier qu\'il désigne' })
  if (lines.includes('@@NOTFILE')) throw createError({ statusCode: 422, statusMessage: 'Pas un fichier' })
  const st = lines.map(parseStat).find(Boolean)
  if (!st) throw createError({ statusCode: 502, statusMessage: 'Lecture du fichier impossible' })
  const file = out.outputs['/tmp/out']?.[0]
  const content = st.size > MAX_TEXT_BYTES ? null : file ? file.content : st.size === 0 ? '' : null
  return {
    path: r,
    size: st.size,
    mtime: new Date(st.mtime * 1000).toISOString(),
    mode: st.mode,
    uid: st.uid,
    gid: st.gid,
    content,
    sha256: content === null ? null : sha(content),
    reason: content !== null ? null : st.size > MAX_TEXT_BYTES ? 'Fichier de plus de 1 Mo : non affiché' : 'Fichier binaire : non affiché',
    writable: m.writable && content !== null,
  }
}

export async function writeServiceFile(t: TargetRow, service: string, input: ServiceFileWrite): Promise<{ backup: string | null, restarted: boolean }> {
  const ctx = await context(t, service)
  const m = mountOf(ctx.mounts, input.mount)
  if (!m.writable) throw createError({ statusCode: 422, statusMessage: `${m.destination} est monté en lecture seule dans ${service}` })
  const r = rel(input.path)
  if (!r && input.sha256 === null) throw createError({ statusCode: 422, statusMessage: 'Nom de fichier requis' })
  const p = portainer()
  const stop = input.stopService && ctx.container.state === 'running'
  if (stop) await p.stopContainer(ctx.conn, ctx.epId, ctx.container.id)
  try {
    const suffix = backupSuffix(new Date())
    const out = await run(ctx, `${m.bind}:/m`, writeScript(r, input.sha256, suffix), { files: [{ path: '/tmp/new', content: input.content }] })
    const lines = out.logs.map(l => l.trimEnd())
    if (lines.includes('@@CHANGED')) throw createError({ statusCode: 409, statusMessage: `Le fichier a changé depuis son ouverture${stop ? ` (${service} l'a peut-être réécrit à son arrêt)` : ''} : le recharger et refaire la modification` })
    if (lines.includes('@@EXISTS')) throw createError({ statusCode: 409, statusMessage: 'Un fichier de ce nom existe déjà' })
    if (lines.includes('@@LINK') || lines.includes('@@NOTFILE')) throw createError({ statusCode: 422, statusMessage: 'Pas un fichier modifiable' })
    if (out.exitCode !== 0 || !lines.includes('@@OK')) throw createError({ statusCode: 502, statusMessage: `Écriture impossible : ${lines.at(-1) ?? `code ${out.exitCode}`}` })
    return { backup: lines.includes('@@BACKUP') ? posix.join(m.destination, `${r}${suffix}`) : null, restarted: stop }
  }
  finally {
    if (stop) await p.startContainer(ctx.conn, ctx.epId, ctx.container.id)
  }
}


const DOWNLOAD_TIMEOUT_MS = 2 * 3600_000

/**
 * Téléchargement d'un fichier (binaire ou volumineux) : lu en flux dans un conteneur porteur qui
 * monte le seul montage concerné en lecture seule, extrait de l'archive de Docker et transmis tel
 * quel ; rien n'est stocké par la console. Le porteur est supprimé à la fin (ou à l'abandon).
 */
export async function downloadServiceFile(t: TargetRow, service: string, mount: string, path: string, maxBytes: number | null = null): Promise<{ name: string, size: number, stream: Readable }> {
  const ctx = await context(t, service)
  const m = mountOf(ctx.mounts, mount)
  const r = rel(path)
  const out = await run(ctx, `${m.bind}:/m:ro`, statScript(r))
  const lines = out.logs.map(l => l.trimEnd())
  if (lines.includes('@@LINK')) throw createError({ statusCode: 422, statusMessage: 'Lien symbolique : télécharger le fichier qu\'il désigne' })
  if (lines.includes('@@NOTFILE')) throw createError({ statusCode: 422, statusMessage: 'Pas un fichier' })
  const st = lines.map(parseStat).find(Boolean)
  if (!st) throw createError({ statusCode: 502, statusMessage: 'Lecture du fichier impossible' })
  if (maxBytes !== null && st.size > maxBytes) throw createError({ statusCode: 413, statusMessage: `Image de plus de ${Math.round(maxBytes / 1024 / 1024)} Mo : la télécharger` })
  const p = portainer()
  const holder = await p.createHolder(ctx.conn, ctx.epId, { image: HELPER_IMAGE, binds: [`${m.bind}:/m:ro`], labels: { 'platform.managed': 'true', 'platform.role': 'service-files' } })
  let removed = false
  const cleanup = () => {
    if (removed) return
    removed = true
    void p.removeContainer(ctx.conn, ctx.epId, holder).catch(() => {})
  }
  try {
    const { stream: tar } = await p.openArchive(ctx.conn, ctx.epId, holder, target(r), DOWNLOAD_TIMEOUT_MS)
    const body = new PassThrough()
    const ex = extract()
    let sent = false
    ex.on('entry', (h, entry, next) => {
      if (!sent && h.type === 'file') {
        sent = true
        entry.pipe(body)
        entry.on('end', next)
      }
      else {
        entry.on('end', next)
        entry.resume()
      }
    })
    ex.on('finish', () => {
      if (!sent) body.destroy(new Error('Fichier absent de l\'archive'))
      cleanup()
    })
    ex.on('error', (err) => {
      body.destroy(err)
      cleanup()
    })
    tar.on('error', err => ex.destroy(err))
    // Client parti avant la fin : lecture interrompue, porteur supprimé.
    body.on('close', () => {
      tar.destroy()
      cleanup()
    })
    tar.pipe(ex)
    return { name: downloadName(posix.basename(r || m.destination)), size: st.size, stream: body }
  }
  catch (err) {
    cleanup()
    throw err
  }
}

/**
 * Envoi d'un fichier dans un dossier d'un montage : corps transmis en flux dans une archive tar
 * (propriétaire du dossier, droits 0644) déposée par Docker dans un conteneur porteur ; rien
 * n'est stocké par la console. Un fichier existant n'est remplacé que sur demande, après copie
 * de son ancienne version à côté.
 */
export async function uploadServiceFile(t: TargetRow, service: string, input: { mount: string, dir: string, name: string, overwrite: boolean, size: number, body: Readable }): Promise<{ path: string, backup: string | null }> {
  if (!Number.isFinite(input.size) || input.size < 0) throw createError({ statusCode: 411, statusMessage: 'Taille du fichier requise (Content-Length)' })
  if (input.size > MAX_UPLOAD_BYTES) throw createError({ statusCode: 413, statusMessage: 'Fichier de plus de 2 Go : le copier directement sur l\'hôte' })
  const ctx = await context(t, service)
  const m = mountOf(ctx.mounts, input.mount)
  if (!m.writable) throw createError({ statusCode: 422, statusMessage: `${m.destination} est monté en lecture seule dans ${service}` })
  const dir = rel(input.dir)
  let name: string
  try {
    name = safeFileName(input.name)
  }
  catch (err) {
    throw createError({ statusCode: 422, statusMessage: (err as Error).message })
  }
  const file = dir ? `${dir}/${name}` : name
  const check = (await run(ctx, `${m.bind}:/m:ro`, uploadCheckScript(dir, file))).logs.map(l => l.trimEnd())
  if (check.includes('@@NODIR')) throw createError({ statusCode: 422, statusMessage: 'Dossier de destination introuvable (ou montage réduit à un fichier)' })
  if (check.includes('@@LINK') || check.includes('@@ISDIR')) throw createError({ statusCode: 422, statusMessage: `${name} existe déjà et n'est pas un fichier` })
  const exists = check.includes('@@EXISTS')
  if (exists && !input.overwrite) throw createError({ statusCode: 409, statusMessage: `${name} existe déjà dans ce dossier` })
  const owner = check.find(l => l.startsWith('@@OWNER '))?.slice(8).split(':').map(Number) ?? [0, 0]
  let backup: string | null = null
  if (exists) {
    const suffix = backupSuffix(new Date())
    const out = await run(ctx, `${m.bind}:/m`, backupScript(file, suffix))
    if (!out.logs.some(l => l.includes('@@BACKUP'))) throw createError({ statusCode: 502, statusMessage: `Copie de l'ancienne version impossible : ${out.logs.at(-1) ?? `code ${out.exitCode}`}` })
    backup = posix.join(m.destination, `${file}${suffix}`)
  }
  const p = portainer()
  const holder = await p.createHolder(ctx.conn, ctx.epId, { image: HELPER_IMAGE, binds: [`${m.bind}:/m`], labels: { 'platform.managed': 'true', 'platform.role': 'service-files' } })
  try {
    const tar = pack()
    const entry = tar.entry({ name, size: input.size, mode: 0o644, uid: owner[0] ?? 0, gid: owner[1] ?? 0, mtime: new Date() }, (err) => {
      if (err) tar.destroy(err)
      else tar.finalize()
    })
    input.body.on('error', err => tar.destroy(err))
    input.body.pipe(entry)
    await p.putArchive(ctx.conn, ctx.epId, holder, target(dir), tar as unknown as Readable, DOWNLOAD_TIMEOUT_MS)
    return { path: posix.join(m.destination, file), backup }
  }
  finally {
    await p.removeContainer(ctx.conn, ctx.epId, holder).catch(() => {})
  }
}

/** Suppression d'un fichier, d'un lien ou d'un dossier (son contenu compris si `recursive`). Jamais la racine d'un montage. */
export async function deleteServiceFile(t: TargetRow, service: string, mount: string, path: string, recursive: boolean): Promise<{ path: string }> {
  const ctx = await context(t, service)
  const m = mountOf(ctx.mounts, mount)
  if (!m.writable) throw createError({ statusCode: 422, statusMessage: `${m.destination} est monté en lecture seule dans ${service}` })
  const r = rel(path)
  if (!r) throw createError({ statusCode: 422, statusMessage: 'La racine d\'un montage ne se supprime pas' })
  const out = await run(ctx, `${m.bind}:/m`, deleteScript(r, recursive))
  const lines = out.logs.map(l => l.trimEnd())
  const full = posix.join(m.destination, r)
  if (lines.includes('@@NONE')) throw createError({ statusCode: 404, statusMessage: `${full} : introuvable` })
  if (lines.includes('@@NOTEMPTY')) throw createError({ statusCode: 409, statusMessage: `${full} n'est pas vide : confirmer la suppression de son contenu` })
  if (!lines.includes('@@OK')) throw createError({ statusCode: 502, statusMessage: `Suppression de ${full} impossible : ${lines.at(-1) ?? `code ${out.exitCode}`}` })
  return { path: full }
}

function fileName(name: string): string {
  try {
    return safeFileName(name)
  }
  catch (err) {
    throw createError({ statusCode: 422, statusMessage: (err as Error).message })
  }
}

/** Renommage dans le même dossier. Jamais la racine d'un montage. */
export async function renameServiceFile(t: TargetRow, service: string, mount: string, path: string, newName: string): Promise<{ from: string, to: string }> {
  const ctx = await context(t, service)
  const m = mountOf(ctx.mounts, mount)
  if (!m.writable) throw createError({ statusCode: 422, statusMessage: `${m.destination} est monté en lecture seule dans ${service}` })
  const r = rel(path)
  if (!r) throw createError({ statusCode: 422, statusMessage: 'La racine d\'un montage ne se renomme pas' })
  const name = fileName(newName)
  const out = await run(ctx, `${m.bind}:/m`, renameScript(r, name))
  const lines = out.logs.map(l => l.trimEnd())
  const from = posix.join(m.destination, r)
  const to = posix.join(m.destination, posix.dirname(r), name)
  if (lines.includes('@@NONE')) throw createError({ statusCode: 404, statusMessage: `${from} : introuvable` })
  if (lines.includes('@@EXISTS')) throw createError({ statusCode: 409, statusMessage: `${name} existe déjà dans ce dossier` })
  if (!lines.includes('@@OK')) throw createError({ statusCode: 502, statusMessage: `Renommage impossible : ${lines.at(-1) ?? `code ${out.exitCode}`}` })
  return { from, to }
}

/** Nouveau dossier dans un dossier d'un montage en écriture. */
export async function makeServiceDir(t: TargetRow, service: string, mount: string, parent: string, newName: string): Promise<{ path: string }> {
  const ctx = await context(t, service)
  const m = mountOf(ctx.mounts, mount)
  if (!m.writable) throw createError({ statusCode: 422, statusMessage: `${m.destination} est monté en lecture seule dans ${service}` })
  const r = rel(parent)
  const name = fileName(newName)
  const out = await run(ctx, `${m.bind}:/m`, mkdirScript(r, name))
  const lines = out.logs.map(l => l.trimEnd())
  if (lines.includes('@@NODIR')) throw createError({ statusCode: 422, statusMessage: 'Dossier parent introuvable' })
  if (lines.includes('@@EXISTS')) throw createError({ statusCode: 409, statusMessage: `${name} existe déjà dans ce dossier` })
  if (!lines.includes('@@OK')) throw createError({ statusCode: 502, statusMessage: `Création impossible : ${lines.at(-1) ?? `code ${out.exitCode}`}` })
  return { path: posix.join(m.destination, r, name) }
}

/** Déplacement d'un fichier, d'un lien ou d'un dossier vers un autre dossier du même montage. */
export async function moveServiceFile(t: TargetRow, service: string, mount: string, path: string, toDir: string): Promise<{ from: string, to: string }> {
  const ctx = await context(t, service)
  const m = mountOf(ctx.mounts, mount)
  if (!m.writable) throw createError({ statusCode: 422, statusMessage: `${m.destination} est monté en lecture seule dans ${service}` })
  const r = rel(path)
  if (!r) throw createError({ statusCode: 422, statusMessage: 'La racine d\'un montage ne se déplace pas' })
  const d = rel(toDir)
  const out = await run(ctx, `${m.bind}:/m`, moveScript(r, d))
  const lines = out.logs.map(l => l.trimEnd())
  const from = posix.join(m.destination, r)
  const to = posix.join(m.destination, d, posix.basename(r))
  if (lines.includes('@@NONE')) throw createError({ statusCode: 404, statusMessage: `${from} : introuvable` })
  if (lines.includes('@@NODIR')) throw createError({ statusCode: 422, statusMessage: `${posix.join(m.destination, d)} n'est pas un dossier` })
  if (lines.includes('@@INTO')) throw createError({ statusCode: 422, statusMessage: 'Un dossier ne peut pas être déplacé dans lui-même' })
  if (lines.includes('@@SAME')) throw createError({ statusCode: 422, statusMessage: 'Déjà dans ce dossier' })
  if (lines.includes('@@EXISTS')) throw createError({ statusCode: 409, statusMessage: `${posix.basename(r)} existe déjà dans ${posix.join(m.destination, d)}` })
  if (!lines.includes('@@OK')) throw createError({ statusCode: 502, statusMessage: `Déplacement impossible : ${lines.at(-1) ?? `code ${out.exitCode}`}` })
  return { from, to }
}

/** Copie d'un fichier, d'un lien ou d'un dossier (et son contenu) dans un dossier du même montage. */
export async function copyServiceFile(t: TargetRow, service: string, mount: string, path: string, toDir: string): Promise<{ from: string, to: string }> {
  const ctx = await context(t, service)
  const m = mountOf(ctx.mounts, mount)
  if (!m.writable) throw createError({ statusCode: 422, statusMessage: `${m.destination} est monté en lecture seule dans ${service}` })
  const r = rel(path)
  if (!r) throw createError({ statusCode: 422, statusMessage: 'La racine d\'un montage ne se copie pas' })
  const d = rel(toDir)
  // Gros dossiers : jusqu'à 30 minutes.
  const out = await run(ctx, `${m.bind}:/m`, copyScript(r, d), { timeoutMs: 30 * 60_000 })
  const lines = out.logs.map(l => l.trimEnd())
  const from = posix.join(m.destination, r)
  if (lines.includes('@@NONE')) throw createError({ statusCode: 404, statusMessage: `${from} : introuvable` })
  if (lines.includes('@@NODIR')) throw createError({ statusCode: 422, statusMessage: `${posix.join(m.destination, d)} n'est pas un dossier` })
  if (lines.includes('@@INTO')) throw createError({ statusCode: 422, statusMessage: 'Un dossier ne peut pas être copié dans lui-même' })
  if (lines.includes('@@EXISTS')) throw createError({ statusCode: 409, statusMessage: `${posix.basename(r)} existe déjà dans ${posix.join(m.destination, d)}` })
  const ok = lines.find(l => l.startsWith('@@OK '))
  if (!ok) throw createError({ statusCode: 502, statusMessage: `Copie impossible : ${lines.at(-1) ?? `code ${out.exitCode}`}` })
  return { from, to: posix.join(m.destination, d, ok.slice(5)) }
}

/** Droits et propriétaire d'un fichier, d'un dossier (récursif au choix) ou d'un lien. */
export async function setServiceFilePermissions(t: TargetRow, service: string, input: { mount: string, path: string, mode: string | null, uid: number | null, gid: number | null, recursive: boolean }): Promise<{ path: string, mode: string, owner: string }> {
  if (input.mode === null && input.uid === null && input.gid === null) throw createError({ statusCode: 422, statusMessage: 'Rien à changer' })
  if (input.mode !== null && !validMode(input.mode)) throw createError({ statusCode: 422, statusMessage: 'Mode invalide : 3 ou 4 chiffres octaux (ex. 644, 0755) ; setuid et setgid refusés' })
  const ctx = await context(t, service)
  const m = mountOf(ctx.mounts, input.mount)
  if (!m.writable) throw createError({ statusCode: 422, statusMessage: `${m.destination} est monté en lecture seule dans ${service}` })
  const r = rel(input.path)
  const out = await run(ctx, `${m.bind}:/m`, permissionsScript(r, input), { timeoutMs: 30 * 60_000 })
  const lines = out.logs.map(l => l.trimEnd())
  const full = posix.join(m.destination, r)
  if (lines.includes('@@NONE')) throw createError({ statusCode: 404, statusMessage: `${full} : introuvable` })
  if (lines.includes('@@LINKMODE')) throw createError({ statusCode: 422, statusMessage: 'Les droits d\'un lien ne se changent pas (seulement son propriétaire)' })
  const ok = lines.find(l => l.startsWith('@@OK '))
  if (!ok) throw createError({ statusCode: 502, statusMessage: `Changement impossible : ${lines.at(-1) ?? `code ${out.exitCode}`}` })
  const [mode, owner] = ok.slice(5).split(' ')
  return { path: full, mode: mode!.padStart(4, '0'), owner: owner! }
}

/** Recherche de fichiers sous un dossier d'un montage (nom ou contenu). */
export async function searchServiceFiles(t: TargetRow, service: string, mount: string, path: string, q: string, content: boolean) {
  const query = q.trim()
  if (query.length < 2 || query.length > 200 || /[\0\n\r]/.test(query)) throw createError({ statusCode: 422, statusMessage: 'Recherche : 2 à 200 caractères' })
  const ctx = await context(t, service)
  const m = mountOf(ctx.mounts, mount)
  const r = rel(path)
  const out = await run(ctx, `${m.bind}:/m:ro`, searchScript(r, query, content), { outputs: [LIST_OUTPUT], timeoutMs: 90_000 })
  const text = out.outputs[LIST_OUTPUT]?.[0]?.content
  if (text === undefined) throw createError({ statusCode: 502, statusMessage: `Recherche impossible${out.logs.length ? ` : ${out.logs.at(-1)}` : ''}` })
  const found = parseSearch(text)
  if (found.state === 'none') throw createError({ statusCode: 404, statusMessage: `${posix.join(m.destination, r)} : introuvable` })
  return { mount, path: r, q: query, content, truncated: found.truncated, results: found.results.map(e => ({ ...e, mtime: new Date(e.mtime * 1000).toISOString() })) }
}

/** Extraction d'une archive zip ou tar d'un montage en écriture, dans un nouveau dossier à côté d'elle. */
export async function extractServiceArchive(t: TargetRow, service: string, mount: string, path: string): Promise<{ path: string, entries: number, bytes: number }> {
  const ctx = await context(t, service)
  const m = mountOf(ctx.mounts, mount)
  if (!m.writable) throw createError({ statusCode: 422, statusMessage: `${m.destination} est monté en lecture seule dans ${service}` })
  const r = rel(path)
  const arch = archiveOf(r)
  if (!r || !arch) throw createError({ statusCode: 422, statusMessage: 'Archive attendue : .zip, .tar, .tar.gz, .tgz, .tar.bz2, .tar.xz' })
  let folder: string
  try {
    folder = safeFileName(arch.folder)
  }
  catch {
    folder = 'archive'
  }
  const out = await run(ctx, `${m.bind}:/m`, extractScript(r, arch.kind, folder), { timeoutMs: 30 * 60_000 })
  const lines = out.logs.map(l => l.trimEnd())
  const full = posix.join(m.destination, r)
  if (lines.includes('@@NOTFILE')) throw createError({ statusCode: 422, statusMessage: `${full} n'est pas un fichier` })
  const bad = lines.find(l => l.startsWith('@@BADARCHIVE'))
  if (bad) {
    const why = bad.slice(12).trim()
    throw createError({ statusCode: 422, statusMessage: `${full} : ${why ? `extraction refusée (${why.replace(/^(tar|unzip): /, '')}) ; rien n'a été écrit` : 'archive illisible ou format non pris en charge'}` })
  }
  if (lines.includes('@@COPYFAILED')) throw createError({ statusCode: 502, statusMessage: 'Copie des fichiers extraits impossible (place ou droits)' })
  const space = lines.find(l => l.startsWith('@@NOSPACE '))
  if (space) {
    const [total, freem] = space.slice(10).split(' ').map(Number)
    throw createError({ statusCode: 507, statusMessage: `Archive de ${formatBytes(total ?? 0)} une fois extraite : place insuffisante (${formatBytes(Math.max(0, freem ?? 0))} libres)` })
  }
  const ok = lines.find(l => l.startsWith('@@OK '))
  if (!ok) throw createError({ statusCode: 502, statusMessage: `Extraction impossible : ${lines.at(-1) ?? `code ${out.exitCode}`}` })
  const [name, entries, bytes] = ok.slice(5).split(' ')
  return { path: posix.join(m.destination, posix.dirname(r), name!), entries: Number(entries), bytes: Number(bytes) }
}

/**
 * Zip d'un ou plusieurs éléments (fichiers, dossiers et leur contenu) d'un même montage, en flux :
 * lus l'un après l'autre dans un conteneur porteur en lecture seule (archive tar de Docker) et
 * compressés par la console. Chaque élément est à la racine de l'archive, sous son nom.
 */
export async function zipServiceFiles(t: TargetRow, service: string, mount: string, paths: string | readonly string[]): Promise<{ name: string, stream: Readable }> {
  const ctx = await context(t, service)
  const m = mountOf(ctx.mounts, mount)
  const list = [...new Set((typeof paths === 'string' ? [paths] : paths).map(rel))]
  if (!list.length) throw createError({ statusCode: 422, statusMessage: 'Aucun élément à archiver' })
  if (list.length > 1 && list.includes('')) throw createError({ statusCode: 422, statusMessage: 'La racine du montage ne se combine pas avec d\'autres éléments' })
  const p = portainer()
  const holder = await p.createHolder(ctx.conn, ctx.epId, { image: HELPER_IMAGE, binds: [`${m.bind}:/m:ro`], labels: { 'platform.managed': 'true', 'platform.role': 'service-files' } })
  let removed = false
  const cleanup = () => {
    if (removed) return
    removed = true
    void p.removeContainer(ctx.conn, ctx.epId, holder).catch(() => {})
  }
  const rootOf = (r: string) => posix.basename(r || m.destination) || 'archive'
  const zip = new ZipStream()
  let current: Readable | null = null
  zip.output.on('close', () => {
    current?.destroy()
    cleanup()
  })
  /** Une archive tar de Docker versée dans le zip (racine renommée d'après l'élément). */
  const pour = (tar: Readable, root: string) => new Promise<void>((resolve, reject) => {
    const ex = extract()
    ex.on('entry', (h, entry, next) => {
      // L'archive de Docker a pour racine le dernier élément du chemin (« m » pour la racine du montage).
      const name = [root, ...h.name.replace(/\/+$/, '').split('/').slice(1)].join('/')
      const base = { name, mode: (h.mode ?? 0o644) & 0o7777, mtime: h.mtime ?? new Date() }
      const add = h.type === 'file' || h.type === 'contiguous-file'
        ? zip.add({ ...base, kind: 'file', data: entry as unknown as Readable })
        : (entry.resume(), h.type === 'directory' ? zip.add({ ...base, kind: 'dir' }) : h.type === 'symlink' ? zip.add({ ...base, kind: 'symlink', linkname: h.linkname ?? '' }) : Promise.resolve())
      add.then(() => next(), (err: Error) => {
        entry.resume()
        ex.destroy(err)
      })
    })
    ex.on('finish', () => resolve())
    ex.on('error', reject)
    tar.on('error', err => ex.destroy(err))
    tar.pipe(ex)
  })
  // Premier élément ouvert avant de répondre (chemin introuvable : erreur immédiate et lisible).
  try {
    current = (await p.openArchive(ctx.conn, ctx.epId, holder, target(list[0]!), DOWNLOAD_TIMEOUT_MS)).stream
  }
  catch (err) {
    cleanup()
    throw err
  }
  void (async () => {
    try {
      for (const [i, r] of list.entries()) {
        if (i > 0) current = (await p.openArchive(ctx.conn, ctx.epId, holder, target(r), DOWNLOAD_TIMEOUT_MS)).stream
        await pour(current!, rootOf(r))
      }
      await zip.finish()
    }
    catch (err) {
      zip.output.destroy(err as Error)
    }
    finally {
      cleanup()
    }
  })()
  const parent = posix.dirname(list[0]!)
  const name = list.length === 1 ? rootOf(list[0]!) : `${posix.basename(parent === '.' ? m.destination : parent) || 'selection'}-selection`
  return { name: downloadName(`${name}.zip`), stream: zip.output }
}

const MAX_ZIP_BYTES = 2 * 1024 ** 3

/**
 * « Créer une archive zip » : zip écrit dans un fichier temporaire de la console (2 Go au plus),
 * puis déposé à côté de l'élément (« nom.zip », « nom-2.zip »…) comme un envoi de fichier.
 */
export async function createServiceZip(t: TargetRow, service: string, mount: string, paths: string | readonly string[]): Promise<{ path: string, size: number }> {
  const ctx = await context(t, service)
  const m = mountOf(ctx.mounts, mount)
  if (!m.writable) throw createError({ statusCode: 422, statusMessage: `${m.destination} est monté en lecture seule dans ${service} : télécharger le zip à la place` })
  const list = (typeof paths === 'string' ? [paths] : [...paths]).map(rel)
  if (list.includes('')) throw createError({ statusCode: 422, statusMessage: 'La racine d\'un montage ne peut pas contenir son propre zip : télécharger le zip à la place' })
  const parents = new Set(list.map(r => (posix.dirname(r) === '.' ? '' : posix.dirname(r))))
  if (parents.size !== 1) throw createError({ statusCode: 422, statusMessage: 'Éléments à archiver : tous dans le même dossier' })
  const r = list[0]!
  const dir = await mkdtemp(posix.join(tmpdir(), 'pp-zip-'))
  const file = posix.join(dir, 'archive.zip')
  try {
    const { name, stream } = await zipServiceFiles(t, service, mount, list)
    let written = 0
    stream.on('data', (c: Buffer) => {
      written += c.length
      if (written > MAX_ZIP_BYTES) stream.destroy(new ZipLimitError('Zip de plus de 2 Go : le télécharger plutôt que le créer sur le serveur'))
    })
    try {
      await pipeline(stream, createWriteStream(file))
    }
    catch (err) {
      throw createError({ statusCode: err instanceof ZipLimitError ? 413 : 502, statusMessage: err instanceof ZipLimitError ? err.message : `Création du zip impossible : ${(err as Error).message}` })
    }
    const size = (await stat(file)).size
    const parent = posix.dirname(r) === '.' ? '' : posix.dirname(r)
    const stem = name.replace(/\.zip$/, '')
    for (let i = 1; i <= 50; i++) {
      const candidate = i === 1 ? `${stem}.zip` : `${stem}-${i}.zip`
      try {
        const up = await uploadServiceFile(t, service, { mount, dir: parent, name: candidate, overwrite: false, size, body: createReadStream(file) })
        return { path: up.path, size }
      }
      catch (err) {
        if ((err as { statusCode?: number }).statusCode !== 409) throw err
      }
    }
    throw createError({ statusCode: 409, statusMessage: `Trop d'archives ${stem}-N.zip dans ce dossier` })
  }
  finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {})
  }
}

/** Versions gardées d'un fichier (copies faites par la console avant chaque modification), plus récentes d'abord. */
export async function listFileVersions(t: TargetRow, service: string, mount: string, path: string): Promise<{ name: string, path: string, at: string, size: number }[]> {
  const ctx = await context(t, service)
  const m = mountOf(ctx.mounts, mount)
  const r = rel(path)
  if (!r) throw createError({ statusCode: 422, statusMessage: 'Fichier attendu' })
  const out = await run(ctx, `${m.bind}:/m:ro`, versionsScript(r), { outputs: [LIST_OUTPUT] })
  const text = out.outputs[LIST_OUTPUT]?.[0]?.content ?? ''
  const base = posix.basename(r)
  const dir = posix.dirname(r) === '.' ? '' : posix.dirname(r)
  return parseList(text.split('\n')).entries
    .filter(e => e.kind === 'file' && isVersionOf(base, e.name))
    .map(e => ({ name: e.name, path: dir ? `${dir}/${e.name}` : e.name, at: (versionDate(e.name) ?? new Date(e.mtime * 1000)).toISOString(), size: e.size }))
    .sort((a, b) => b.at.localeCompare(a.at))
}

/** Restauration d'une version (la version actuelle est gardée avant) ; service arrêté puis relancé au choix. */
export async function restoreFileVersion(t: TargetRow, service: string, input: { mount: string, path: string, version: string, stopService: boolean }): Promise<{ path: string, backup: string | null, restarted: boolean }> {
  const ctx = await context(t, service)
  const m = mountOf(ctx.mounts, input.mount)
  if (!m.writable) throw createError({ statusCode: 422, statusMessage: `${m.destination} est monté en lecture seule dans ${service}` })
  const r = rel(input.path)
  if (!r || !isVersionOf(posix.basename(r), input.version)) throw createError({ statusCode: 422, statusMessage: 'Version inconnue pour ce fichier' })
  const p = portainer()
  const stop = input.stopService && ctx.container.state === 'running'
  if (stop) await p.stopContainer(ctx.conn, ctx.epId, ctx.container.id)
  try {
    const suffix = backupSuffix(new Date())
    const out = await run(ctx, `${m.bind}:/m`, restoreVersionScript(r, input.version, suffix))
    const lines = out.logs.map(l => l.trimEnd())
    if (lines.includes('@@NONE')) throw createError({ statusCode: 404, statusMessage: `Version ${input.version} introuvable` })
    if (lines.includes('@@LINK')) throw createError({ statusCode: 422, statusMessage: 'Le fichier est un lien symbolique' })
    if (!lines.includes('@@OK')) throw createError({ statusCode: 502, statusMessage: `Restauration impossible : ${lines.at(-1) ?? `code ${out.exitCode}`}` })
    return { path: posix.join(m.destination, r), backup: lines.includes('@@BACKUP') ? posix.join(m.destination, `${r}${suffix}`) : null, restarted: stop }
  }
  finally {
    if (stop) await p.startContainer(ctx.conn, ctx.epId, ctx.container.id)
  }
}
