/**
 * Migration d'une stack gérée vers un autre serveur géré (même projet, même environnement) :
 * serveurs possibles, plan (éléments copiés et leur taille, empêchements avec l'action qui les
 * lève, analyse du Compose avec les politiques de la cible), demande, copie des données d'un hôte
 * à l'autre et nettoyage de l'ancienne stack. L'exécution est celle du worker (pipeline).
 *
 * Copie : un conteneur « porteur » jamais démarré monte l'élément sur chaque hôte ; l'archive tar
 * lue sur l'origine est déposée en flux sur la cible (aucun fichier intermédiaire, propriétaires
 * et droits conservés), puis le nombre de fichiers est contrôlé sur la cible.
 */
import { posix } from 'node:path'
import { PassThrough } from 'node:stream'
import { and, eq, ne } from 'drizzle-orm'
import { createError } from 'h3'
import { extract } from 'tar-stream'
import type { MigratedFrom, MigrationDestination, MigrationInput, MigrationItem, MigrationPlan } from '../../shared/schemas/migration'
import { formatBytes } from '../../shared/utils/format'
import { type PortainerConnection, portainer } from '../adapters/portainer'
import { type TargetRunner, runnerFor } from '../adapters/runner'
import { db, schema } from '../db/client'
import type { PortApproval } from '../lib/compose/analyze'
import { type MigrationLayout, holderBind, migrationItems, parseSizes, sizeScript, volumeLabels } from '../lib/stack-migration'
import { type Progress, noProgress } from '../utils/progress'
import { type ProjectLayout, assertInsideProject, projectLayout } from '../utils/path-guard'
import { assertTargetIdle, createLifecycleAction } from './deploy-requests'
import { stackOfTarget } from './diagnostic'
import { type TargetRow, analyzeWithSubnets, buildAnalyzeContext } from './projects'
import { releaseSourceFiles } from './release-sources'
import { removeReleaseDirs } from './release-files'
import { connectionFor } from './servers'

export const HELPER_IMAGE = process.env.HOST_HELPER_IMAGE || 'busybox:1.37'
const COPY_TIMEOUT_MS = 6 * 3600_000
const MB = 1024 * 1024

type PathsRow = typeof schema.pathConfigs.$inferSelect
type ServerRow = typeof schema.portainerServers.$inferSelect
type EndpointRow = typeof schema.serverEndpoints.$inferSelect

export interface Side {
  endpoint: EndpointRow
  server: ServerRow
  paths: PathsRow | undefined
  conn: () => Promise<PortainerConnection>
}

export async function sideOf(endpointId: string, environmentId: string): Promise<Side> {
  const [r] = await db().select({ endpoint: schema.serverEndpoints, server: schema.portainerServers })
    .from(schema.serverEndpoints)
    .innerJoin(schema.portainerServers, eq(schema.portainerServers.id, schema.serverEndpoints.serverId))
    .where(eq(schema.serverEndpoints.id, endpointId))
  if (!r) throw createError({ statusCode: 404, statusMessage: 'Serveur de destination introuvable' })
  const [paths] = await db().select().from(schema.pathConfigs).where(and(eq(schema.pathConfigs.endpointId, endpointId), eq(schema.pathConfigs.environmentId, environmentId)))
  let conn: Promise<PortainerConnection> | null = null
  return { ...r, paths, conn: () => (conn ??= connectionFor(r.server)) }
}

/** Disposition du projet sur un hôte ; chemin choisi invalide sur la cible : racines par défaut. */
export function layoutOn(paths: PathsRow, slug: string, projectPath: string | null): { layout: ProjectLayout, projectPath: string | null } {
  try {
    return { layout: projectLayout(paths, slug, projectPath), projectPath }
  }
  catch {
    return { layout: projectLayout(paths, slug, null), projectPath: null }
  }
}

/** Cible vue depuis l'autre serveur : mêmes réglages, endpoint et serveur de destination. */
export function targetOn(t: TargetRow, to: Side, projectPath: string | null, opts: { previewWatchtower?: boolean } = {}): TargetRow {
  const target = { ...t.target, endpointId: to.endpoint.id, portainerStackId: null, projectPath }
  // Aperçu : Watchtower non résolu (il crée au besoin un profil sur le serveur).
  if (opts.previewWatchtower === false) target.watchtower = { ...target.watchtower, enabled: false }
  return { ...t, target, endpoint: to.endpoint, server: { id: to.server.id, name: to.server.name } }
}

// ---------------------------------------------------------------------------
// Serveurs possibles
// ---------------------------------------------------------------------------

async function unavailableReason(t: TargetRow, ep: EndpointRow, server: ServerRow): Promise<string | null> {
  if (!ep.enabled || ep.missing) return 'endpoint désactivé ou absent (à activer dans la fiche du serveur)'
  if (ep.type !== 'docker_standalone') return 'seuls les hôtes Docker autonomes sont pris en charge'
  if (server.status === 'offline') return 'serveur hors ligne'
  const linked = await db().$count(schema.endpointEnvironments, and(eq(schema.endpointEnvironments.endpointId, ep.id), eq(schema.endpointEnvironments.environmentId, t.env.id)))
  if (!linked) return `n'accepte pas l'environnement ${t.env.name} (à ajouter dans la fiche du serveur, onglet Environnements)`
  const paths = await db().$count(schema.pathConfigs, and(eq(schema.pathConfigs.endpointId, ep.id), eq(schema.pathConfigs.environmentId, t.env.id)))
  if (!paths) return `chemins de travail non configurés pour ${t.env.name} (fiche du serveur, onglet Chemins)`
  const taken = await db().$count(schema.projectTargets, and(eq(schema.projectTargets.projectId, t.project.id), eq(schema.projectTargets.endpointId, ep.id), eq(schema.projectTargets.environmentId, t.env.id)))
  if (taken) return 'le projet y a déjà une cible pour cet environnement'
  return null
}

export async function migrationDestinations(t: TargetRow): Promise<MigrationDestination[]> {
  const rows = await db().select({ endpoint: schema.serverEndpoints, server: schema.portainerServers })
    .from(schema.serverEndpoints)
    .innerJoin(schema.portainerServers, eq(schema.portainerServers.id, schema.serverEndpoints.serverId))
    .where(ne(schema.serverEndpoints.id, t.endpoint.id))
  const out: MigrationDestination[] = []
  for (const r of rows) {
    out.push({
      endpointId: r.endpoint.id,
      serverId: r.server.id,
      serverName: r.server.name,
      endpointName: r.endpoint.name,
      online: r.server.status !== 'offline' && r.endpoint.online,
      transport: r.server.transport,
      unavailable: await unavailableReason(t, r.endpoint, r.server),
    })
  }
  return out.sort((a, b) => Number(!!a.unavailable) - Number(!!b.unavailable) || a.serverName.localeCompare(b.serverName))
}

// ---------------------------------------------------------------------------
// Éléments copiés
// ---------------------------------------------------------------------------

/** Fichiers d'un conteneur ponctuel sur un hôte (mesure, vidage, contrôle). */
async function helper(side: Side, binds: string[], script: string, label: string): Promise<string[]> {
  const r = await portainer().runOneShot(await side.conn(), side.endpoint.portainerEndpointId, {
    image: HELPER_IMAGE,
    entrypoint: ['sh', '-c'],
    cmd: [script],
    binds,
    files: [],
    outputs: [],
    outputLimits: { maxBytes: 0, maxFiles: 0 },
    labels: { 'platform.managed': 'true', 'platform.role': 'migration' },
    timeoutMs: COPY_TIMEOUT_MS,
    memoryMb: 256,
  })
  const lines = r.logs.map(l => l.trim()).filter(Boolean)
  if (r.exitCode !== 0) throw new Error(`${label} : ${lines.at(-1) ?? `code ${r.exitCode}`}`)
  return lines
}

export interface ItemContext {
  t: TargetRow
  from: Side
  to: Side
  stackName: string
  releaseSlug: string
  fromLayout: ProjectLayout
  toLayout: ProjectLayout
  runnerFrom: TargetRunner
}

/** Éléments de la stack sur l'origine, mesurés (taille, nature) ; montages ignorés avec leur raison. */
export async function collectItems(c: ItemContext): Promise<{ items: MigrationItem[], ignored: { source: string, service: string, reason: string }[] }> {
  const p = portainer()
  const containers = (await p.listContainers(await c.from.conn(), c.from.endpoint.portainerEndpointId)).filter(x => x.labels['com.docker.compose.project'] === c.stackName)
  const mounts = containers.flatMap(x => (x.mounts ?? []).map(m => ({ ...m, service: x.labels['com.docker.compose.service'] ?? x.names[0] ?? '?' })))
  const fromL: MigrationLayout = { projectDir: c.fromLayout.projectDir, releasesDir: c.fromLayout.releasesDir, runtimeDir: c.fromLayout.runtimeDir, releaseDir: c.fromLayout.release(c.releaseSlug).dir }
  const { items, ignored } = migrationItems(mounts, fromL, { runtimeDir: c.toLayout.runtimeDir, releaseDir: c.toLayout.release(c.releaseSlug).dir })
  // Volumes de la stack sans conteneur (service suspendu, arrêté puis supprimé) : copiés aussi.
  for (const v of await p.listVolumes(await c.from.conn(), c.from.endpoint.portainerEndpointId)) {
    if (v.labels['com.docker.compose.project'] !== c.stackName || items.some(i => i.id === `volume:${v.name}`)) continue
    items.push({ id: `volume:${v.name}`, kind: 'volume', label: `Volume ${v.name}`, source: v.name, destination: v.name, required: false, selected: true, services: [] })
  }
  // Dossiers du projet absents de l'origine : rien à copier (un bind les créerait).
  const rctx = { requestId: `migration-${c.t.target.id}`, actor: 'migration' }
  const present: typeof items = []
  for (const i of items) {
    if ((i.kind === 'release' || i.kind === 'data') && !(await c.runnerFrom.pathExists(rctx, { path: i.source })).exists) continue
    present.push(i)
  }
  const sizes = present.length
    ? parseSizes(await helper(c.from, present.map((i, n) => `${i.source}:/m/${n}:ro`), sizeScript(present.length), 'Mesure des données').catch(() => []))
    : new Map()
  const toVolumes = present.some(i => i.kind === 'volume') ? await p.listVolumes(await c.to.conn(), c.to.endpoint.portainerEndpointId).catch(() => []) : []
  return {
    items: present.map((i, n): MigrationItem => {
      const s = sizes.get(n)
      const isFile = !!s && s.exists && !s.isDir
      let note: string | null = null
      if (isFile) note = 'Fichier isolé : non copiable, à recréer sur la cible'
      else if (i.kind === 'volume' && toVolumes.some(v => v.name === i.source)) note = 'Volume déjà présent sur la cible (essai précédent) : contenu remplacé'
      else if (i.kind === 'bind') note = 'Même chemin sur la cible ; les fichiers existants y sont conservés ou écrasés'
      return { ...i, sizeBytes: s?.bytes ?? null, isFile, selected: i.selected && !isFile, note }
    }),
    ignored,
  }
}

/**
 * Copie d'un élément de l'origine vers la cible : destination vidée (sauf dossier externe),
 * archive transférée en flux, nombre de fichiers contrôlé. Le flux est journalisé toutes les 15 s.
 */
export async function copyItem(c: Pick<ItemContext, 'from' | 'to'>, item: MigrationItem, log: (m: string) => Promise<void>): Promise<{ bytes: number, files: number }> {
  const p = portainer()
  const fromConn = await c.from.conn()
  const toConn = await c.to.conn()
  const fromEp = c.from.endpoint.portainerEndpointId
  const toEp = c.to.endpoint.portainerEndpointId
  const labels = { 'platform.managed': 'true', 'platform.role': 'migration' }
  if (item.kind === 'volume') {
    const v = (await p.listVolumes(fromConn, fromEp)).find(x => x.name === item.source)
    if (v && v.driver !== 'local') throw new Error(`Volume ${item.source} : pilote ${v.driver} non pris en charge (seul « local » se copie)`)
    await p.createVolume(toConn, toEp, { name: item.destination, driver: 'local', labels: volumeLabels(v?.labels ?? {}) })
  }
  if (item.kind !== 'bind') await helper(c.to, [holderBind(item.destination, false)], 'find /m -mindepth 1 -maxdepth 1 -exec rm -rf {} +', `Vidage de ${item.destination}`)

  const src = await p.createHolder(fromConn, fromEp, { image: HELPER_IMAGE, binds: [holderBind(item.source, true)], labels })
  let dst: string | null = null
  try {
    dst = await p.createHolder(toConn, toEp, { image: HELPER_IMAGE, binds: [holderBind(item.destination, false)], labels })
    const { stream } = await p.openArchive(fromConn, fromEp, src, '/m', COPY_TIMEOUT_MS)
    let bytes = 0
    let files = 0
    const t0 = Date.now()
    const ticker = setInterval(() => void log(`${item.label} : ${formatBytes(bytes)} transférés (${formatBytes(bytes / Math.max(1, (Date.now() - t0) / 1000))}/s)`), 15_000)
    // Fichiers comptés au passage (contrôle sur la cible) ; le flux part tel quel vers la cible.
    const counter = extract()
    counter.on('entry', (h, s, next) => {
      if (h.type === 'file' || h.type === 'link' || h.type === 'contiguous-file') files++
      s.on('end', next)
      s.resume()
    })
    counter.on('error', () => {})
    const body = new PassThrough()
    stream.on('data', (chunk: Buffer) => {
      bytes += chunk.length
    })
    stream.pipe(body)
    stream.pipe(counter)
    stream.on('error', err => body.destroy(err))
    try {
      await p.putArchive(toConn, toEp, dst, '/', body, COPY_TIMEOUT_MS)
    }
    catch (err) {
      stream.destroy()
      throw err
    }
    finally {
      clearInterval(ticker)
    }
    const seconds = Math.max(1, Math.round((Date.now() - t0) / 1000))
    const onTarget = Number((await helper(c.to, [holderBind(item.destination, true)], 'find /m -type f | wc -l', `Contrôle de ${item.destination}`)).at(-1) ?? 'NaN')
    // Dossier externe : la cible peut contenir d'autres fichiers ; ailleurs, le compte doit être exact.
    if (Number.isNaN(onTarget) || (item.kind === 'bind' ? onTarget < files : onTarget !== files)) {
      throw new Error(`${item.label} : ${files} fichier(s) envoyé(s), ${Number.isNaN(onTarget) ? 'contrôle illisible' : `${onTarget} présent(s)`} sur la cible`)
    }
    // Release : fichiers de la console, rendus au compte qui gère le dossier sur la cible (compte SSH,
    // Runner) ; les données gardent leurs propriétaires d'origine (ceux des applications).
    // Propriétaire pris sur le dossier parent (releases/, créé pour ce compte) : l'archive a aussi
    // appliqué au dossier de la release le propriétaire qu'il avait sur l'origine.
    if (item.kind === 'release') await helper(c.to, [holderBind(item.destination, false), `${posix.dirname(item.destination)}:/p:ro`], 'chown -R "$(stat -c %u:%g /p)" /m', `Propriétaire de ${item.destination}`)
    await log(`${item.label} copié : ${files} fichier(s), ${formatBytes(bytes)} en ${seconds} s`)
    return { bytes, files }
  }
  finally {
    await p.removeContainer(fromConn, fromEp, src).catch(() => {})
    if (dst) await p.removeContainer(toConn, toEp, dst).catch(() => {})
  }
}

// ---------------------------------------------------------------------------
// Plan
// ---------------------------------------------------------------------------

export async function migrationPlan(t: TargetRow, toEndpointId: string, progress: Progress = noProgress): Promise<MigrationPlan> {
  const blockers: string[] = []
  const notes: string[] = []
  const warnings: string[] = []
  const stackName = stackOfTarget(t)
  const to = await sideOf(toEndpointId, t.env.id)
  const from = await sideOf(t.endpoint.id, t.env.id)
  const plan: MigrationPlan = {
    from: { serverName: t.server.name, endpointName: t.endpoint.name },
    to: { serverName: to.server.name, endpointName: to.endpoint.name, endpointId: to.endpoint.id },
    stackName, items: [], blockers, notes, warnings, freeBytes: null,
    hosts: [...new Set(t.target.exposures.map(e => e.host))],
  }
  if (to.endpoint.id === t.endpoint.id) blockers.push('La stack est déjà sur ce serveur')
  const reason = await unavailableReason(t, to.endpoint, to.server)
  if (reason) blockers.push(`${to.server.name} : ${reason}`)
  if (!t.target.portainerStackId || !t.target.currentReleaseId) blockers.push('Aucune stack déployée pour cette cible : la déployer avant de la migrer')
  if (!from.paths) blockers.push(`Chemins de travail de ${t.server.name} non configurés pour ${t.env.name}`)
  if (blockers.length || !to.paths || !from.paths) return plan

  const [release] = await db().select().from(schema.releases).where(eq(schema.releases.id, t.target.currentReleaseId!))
  if (!release?.slug || !release.composeSource) {
    blockers.push('Release active incomplète (Compose ou dossier absent) : redéployer avant de migrer')
    return plan
  }
  const fromLayout = projectLayout(from.paths, t.project.slug, t.target.projectPath)
  const dest = layoutOn(to.paths, t.project.slug, t.target.projectPath)
  if (t.target.projectPath && !dest.projectPath) notes.push(`Dossier du projet ${t.target.projectPath} hors des racines de ${to.server.name} : dossiers par défaut utilisés sur la cible (${dest.layout.projectDir}, données dans ${dest.layout.runtimeDir})`)

  // Hôtes joignables.
  await progress.step(`Serveurs ${t.server.name} et ${to.server.name}`, 1, 4)
  const p = portainer()
  try {
    await p.listContainers(await from.conn(), from.endpoint.portainerEndpointId)
  }
  catch (err) {
    blockers.push(`Serveur d'origine ${t.server.name} injoignable (${(err as Error).message}) : ses données ne peuvent pas être copiées`)
  }
  let toContainers: Awaited<ReturnType<typeof p.listContainers>> = []
  try {
    toContainers = await p.listContainers(await to.conn(), to.endpoint.portainerEndpointId)
  }
  catch (err) {
    blockers.push(`Serveur ${to.server.name} injoignable : ${(err as Error).message}`)
  }
  const runnerTo = await runnerFor(to.endpoint.id)
  const runnerFrom = await runnerFor(from.endpoint.id)
  const h = await runnerTo.health().catch((err: Error) => ({ error: err.message }))
  if ('error' in h) blockers.push(`Accès aux fichiers de ${to.server.name} impossible (${h.error}) : vérifier le Runner ou l'accès SSH dans la fiche du serveur`)
  if (blockers.length) return plan

  // Compose analysé avec les politiques de la cible (ports, volumes, réseaux, Traefik).
  await progress.step(`Analyse du Compose avec les politiques de ${to.server.name}`, 2, 4)
  const tTo = targetOn(t, to, dest.projectPath, { previewWatchtower: false })
  const ctx = await buildAnalyzeContext(tTo, {
    composePath: release.composePath ?? 'compose.yml',
    files: await releaseSourceFiles(release),
    releaseSlug: release.slug,
    portApprovals: ((release.analysis as { approvals?: PortApproval[] }).approvals) ?? [],
    sourceKind: release.sourceKind === 'github' ? 'github' : 'zip',
    envFileKeys: (release.metadata as { envFileKeys?: Record<string, string[]> }).envFileKeys,
  })
  const analysis = await analyzeWithSubnets(tTo, release.composeSource, ctx, { persist: false })
  for (const i of analysis.issues.filter(x => x.severity === 'error')) blockers.push(`Sur ${to.server.name}${i.service ? ` [${i.service}]` : ''} : ${i.message}`)
  for (const i of analysis.issues.filter(x => x.severity === 'warning')) warnings.push(`${i.service ? `[${i.service}] ` : ''}${i.message}`)

  // Ports publiés déjà pris sur la cible.
  for (const port of analysis.ports.filter(x => x.published !== null)) {
    const holder = toContainers.find(c => c.labels['com.docker.compose.project'] !== stackName && (c.ports ?? []).some(cp => cp.publicPort === port.published && cp.type === port.protocol))
    if (holder) blockers.push(`Port ${port.published}/${port.protocol} (${port.service}) déjà publié sur ${to.server.name} par ${holder.names[0] ?? holder.id.slice(0, 12)} : libérer ce port sur la cible avant de migrer`)
  }
  // Stack ou volumes du même nom sur la cible, hors console.
  const leftover = toContainers.filter(c => c.labels['com.docker.compose.project'] === stackName)
  if (leftover.some(c => c.labels['platform.project'] !== t.project.slug)) blockers.push(`Une stack « ${stackName} » qui n'appartient pas à ce projet tourne déjà sur ${to.server.name} : la supprimer ou la renommer avant de migrer`)
  else if (leftover.length) notes.push(`Restes d'un essai précédent de « ${stackName} » sur ${to.server.name} : remplacés`)

  // Éléments à copier.
  await progress.step(`Mesure des données sur ${t.server.name}`, 3, 4)
  const collected = await collectItems({ t, from, to, stackName, releaseSlug: release.slug, fromLayout, toLayout: dest.layout, runnerFrom })
  plan.items = collected.items
  if (!plan.items.some(i => i.kind === 'release')) {
    if (release.sourceKind === 'github') notes.push('Dossier de la release absent de l\'origine : sources téléchargées à nouveau depuis GitHub sur la cible')
    else blockers.push(`Fichiers de la release #${release.number} absents de ${t.server.name} (archive déjà consommée) : redéployer une archive avant de migrer`)
  }
  const toVolumes = await p.listVolumes(await to.conn(), to.endpoint.portainerEndpointId).catch(() => [])
  for (const v of plan.items.filter(i => i.kind === 'volume')) {
    const existing = toVolumes.find(x => x.name === v.destination)
    if (existing && existing.labels['com.docker.compose.project'] !== stackName) blockers.push(`Le volume ${v.destination} existe déjà sur ${to.server.name} hors de cette stack : le supprimer ou le renommer sur la cible`)
  }
  for (const i of collected.ignored) notes.push(`${i.source} (${i.service}) non copié : ${i.reason}`)

  await progress.step(`Espace disque sur ${to.server.name}`, 4, 4)
  const disk = await runnerTo.diskUsage({ requestId: `migration-${t.target.id}`, actor: 'migration' }, { path: to.paths.runtimeRoot }).catch(() => null)
  plan.freeBytes = disk?.freeBytes ?? null

  const total = plan.items.filter(i => i.selected).reduce((n, i) => n + (i.sizeBytes ?? 0), 0)
  notes.unshift(`La stack reste en service sur ${t.server.name} pendant la préparation (fichiers, images) ; elle n'y est arrêtée que pour copier les données (${formatBytes(total)}), puis démarre sur ${to.server.name}. En cas d'échec, elle redémarre sur ${t.server.name} avec ses données intactes.`)
  if (plan.hosts.length) notes.push(`Après la migration, faire pointer le DNS de ${plan.hosts.join(', ')} vers ${to.server.name}`)
  if (t.target.watchtower?.enabled) notes.push(`Watchtower : profil de même rythme utilisé (ou créé) sur ${to.server.name}`)
  notes.push(`L'ancienne stack reste arrêtée sur ${t.server.name} avec ses données, jusqu'à son nettoyage depuis la page du projet`)
  return plan
}

/** Éléments retenus : obligatoires, et ceux cochés (jamais les fichiers isolés). */
export function selectedItems(items: readonly MigrationItem[], ids: readonly string[]): MigrationItem[] {
  return items.filter(i => !i.isFile && (i.required || ids.includes(i.id)))
}

export async function startMigration(t: TargetRow, input: MigrationInput, user: { id: string | null }, idempotencyKey: string, progress: Progress = noProgress): Promise<{ deploymentId: string }> {
  const stackName = stackOfTarget(t)
  if (input.confirm.trim() !== stackName) throw createError({ statusCode: 422, statusMessage: `Confirmation : saisir le nom de la stack (${stackName})` })
  await assertTargetIdle(t.target.id)
  const plan = await migrationPlan(t, input.endpointId, progress)
  if (plan.blockers.length) throw createError({ statusCode: 422, statusMessage: plan.blockers[0]!, data: { plan } })
  const chosen = selectedItems(plan.items, input.items)
  const total = chosen.reduce((n, i) => n + (i.sizeBytes ?? 0), 0)
  if (plan.freeBytes !== null && total + 512 * MB > plan.freeBytes) {
    throw createError({ statusCode: 422, statusMessage: `Espace insuffisant sur ${plan.to.serverName} : ${formatBytes(total)} à copier (+ 512 Mo de marge), ${formatBytes(plan.freeBytes)} libres — décocher des éléments ou libérer de la place` })
  }
  const deploymentId = await createLifecycleAction(t, 'migrate', user.id, idempotencyKey, { migration: { toEndpointId: input.endpointId, items: chosen.map(i => i.id) } })
  return { deploymentId }
}

// ---------------------------------------------------------------------------
// Nettoyage de l'ancienne stack
// ---------------------------------------------------------------------------

export async function cleanupMigrationSource(t: TargetRow, input: { removeData: boolean, confirm: string }, progress: Progress = noProgress): Promise<{ removed: string[] }> {
  const mf = t.target.migratedFrom
  if (!mf || mf.cleanedAt) throw createError({ statusCode: 409, statusMessage: 'Aucune ancienne stack à nettoyer' })
  if (input.confirm.trim() !== mf.stackName) throw createError({ statusCode: 422, statusMessage: `Confirmation : saisir le nom de la stack (${mf.stackName})` })
  await assertTargetIdle(t.target.id)
  const from = await sideOf(mf.endpointId, t.env.id)
  const p = portainer()
  const conn = await from.conn()
  const ep = from.endpoint.portainerEndpointId
  const removed: string[] = []
  await progress.step(`Suppression de la stack ${mf.stackName} sur ${mf.serverName}`, 1, 3)
  const stack = await p.findStack(conn, mf.stackName, ep)
  if (stack) {
    await p.deleteStack(conn, stack.id, ep)
    removed.push(`stack ${mf.stackName}`)
  }
  await progress.step('Releases et données', 2, 3)
  if (from.paths) {
    const runner = await runnerFor(from.endpoint.id)
    const rctx = { requestId: `migration-cleanup-${t.target.id}`, actor: 'migration' }
    const layout = layoutOn(from.paths, t.project.slug, mf.projectPath).layout
    const bytes = await removeReleaseDirs(runner, rctx, layout, mf.releaseSlugs).catch(() => 0)
    removed.push(`${mf.releaseSlugs.length} release(s) (${formatBytes(bytes)})`)
    if (input.removeData && mf.dataDir && (await runner.pathExists(rctx, { path: mf.dataDir })).exists) {
      const r = await runner.cleanup(rctx, { path: assertInsideProject(mf.dataDir, layout) })
      removed.push(`données ${mf.dataDir} (${formatBytes(r.removedBytes)})`)
    }
  }
  if (input.removeData) {
    for (const v of mf.volumes) {
      await p.removeVolume(conn, ep, v).then(() => removed.push(`volume ${v}`), () => {})
    }
  }
  await progress.step('Enregistrement', 3, 3)
  const next: MigratedFrom = { ...mf, cleanedAt: new Date().toISOString() }
  await db().update(schema.projectTargets).set({ migratedFrom: next }).where(eq(schema.projectTargets.id, t.target.id))
  return { removed }
}
