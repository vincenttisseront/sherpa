/**
 * Analyse de vulnérabilités des images en service (Trivy), planifiée (chaque semaine par défaut)
 * ou à la demande : un conteneur Trivy ponctuel par image sur l'hôte de l'endpoint (socket Docker
 * en lecture, base de vulnérabilités en cache dans un volume), résultat conservé par image.
 * Nouvelles vulnérabilités graves notifiées (« vulnerability.found »).
 */
import { readFile } from 'node:fs/promises'
import { and, eq, inArray, isNotNull, isNull, notInArray, or } from 'drizzle-orm'
import { type Finding, type ImageScanDto, type ScanCleanupInput, type ScanCleanupResult, type ScanTrigger, type TrivyEngineDto, type TrivyQueue, type SeverityCounts, type SourceScanDto, type TrivyRun, type TrivySettings, type TrivyStatus, trivySettingsInput } from '../../shared/schemas/trivy'
import type { PortainerConnection } from '../adapters/portainer'
import { createError } from 'h3'
import { normalizeImage } from '../lib/compose/image-upgrade'
import { latestStableTag, listTags, parseImageRef } from '../lib/registry'
import { portainer } from '../adapters/portainer'
import { db, schema } from '../db/client'
import { TRIVY_CACHE_VOLUME, TRIVY_EXTRA_CA, TRIVY_OUTPUT, TRIVY_SOURCE_DIR, emptyCounts, newFindings, parseTrivyReport, trivyScript } from '../lib/trivy'
import { scanQueue } from '../queue/queues'
import { emitNotification } from './notifications'
import { runnerFor } from '../adapters/runner'
import { projectLayout } from '../utils/path-guard'
import { connectionFor } from './servers'
import { markResolvedRequests } from './remediation'
import { byCode } from '../../shared/utils/compare'
export { blockingFindings } from '../lib/trivy'

const SETTINGS_KEY = 'trivy'
const RUN_KEY = 'trivy-run'
const SCHEDULER = 'trivy-scan'

export async function trivySettings(): Promise<TrivySettings> {
  const [row] = await db().select().from(schema.appSettings).where(eq(schema.appSettings.key, SETTINGS_KEY))
  return trivySettingsInput.parse(row?.value ?? {})
}

export async function saveTrivySettings(value: TrivySettings, userId: string | null): Promise<TrivySettings> {
  await db().insert(schema.appSettings).values({ key: SETTINGS_KEY, value, updatedBy: userId })
    .onConflictDoUpdate({ target: schema.appSettings.key, set: { value, updatedBy: userId, updatedAt: new Date() } })
  await applyTrivySchedule(value)
  return value
}

/** Planification (cron et fuseau) : mise à jour au démarrage du worker et à chaque enregistrement. */
export async function applyTrivySchedule(s?: TrivySettings): Promise<void> {
  const settings = s ?? await trivySettings()
  if (!settings.enabled) {
    await scanQueue().removeJobScheduler(SCHEDULER).catch(() => {})
    return
  }
  await scanQueue().upsertJobScheduler(SCHEDULER, { pattern: settings.cron, tz: settings.timezone }, { name: 'scan', data: { trigger: 'planifiée' } })
}

async function runState(): Promise<TrivyRun | null> {
  const [row] = await db().select().from(schema.appSettings).where(eq(schema.appSettings.key, RUN_KEY))
  return (row?.value as TrivyRun | undefined) ?? null
}
async function saveRun(run: TrivyRun) {
  await db().insert(schema.appSettings).values({ key: RUN_KEY, value: run })
    .onConflictDoUpdate({ target: schema.appSettings.key, set: { value: run, updatedAt: new Date() } })
}

export async function trivyStatus(): Promise<TrivyStatus> {
  return { settings: await trivySettings(), run: await runState(), queue: await queueState().catch(() => null) }
}

/** File des analyses (BullMQ) : en attente, en cours, dernier échec. */
async function queueState(): Promise<TrivyQueue> {
  const q = scanQueue()
  const counts = await q.getJobCounts('waiting', 'active', 'prioritized')
  const [active] = await q.getJobs(['active'], 0, 0)
  const [failed] = await q.getJobs(['failed'], 0, 0, false)
  return {
    waiting: (counts.waiting ?? 0) + (counts.prioritized ?? 0),
    active: counts.active ?? 0,
    activeSince: active?.processedOn ? new Date(active.processedOn).toISOString() : null,
    lastFailure: failed?.failedReason ? { at: new Date(failed.finishedOn ?? failed.timestamp).toISOString(), reason: failed.failedReason.slice(0, 500) } : null,
  }
}

/** Analyse interrompue par une erreur (worker) : état « en cours » levé, erreur conservée. */
export async function failTrivyRun(reason: string): Promise<void> {
  const run = await runState()
  if (!run?.running) return
  await saveRun({ ...run, running: false, current: null, finishedAt: new Date().toISOString(), lastError: reason.slice(0, 500) })
}

/**
 * Analyse liée à un déploiement (blocage désactivé) : lancée après lui, limitée aux services
 * déployés (et au code source si demandé) ; une analyse récente de la même image est reprise.
 */
export interface DeployScanScope { services: string[], source: boolean, deploymentId: string, reuseMs: number }

export async function requestTrivyScan(input: { endpointId?: string, targetId?: string, imageId?: string, sourceOnly?: boolean, trigger: string, deploy?: DeployScanScope }): Promise<void> {
  await scanQueue().add('scan', input, { removeOnComplete: true, removeOnFail: { age: 7 * 24 * 3600 } })
  // Lignes concernées marquées « en file » : visibles tout de suite, même après rechargement de la page.
  await markScope(input, 'queued').catch(() => {})
}

type ScanScope = { endpointId?: string, targetId?: string, imageId?: string, sourceOnly?: boolean }

/** État d'analyse des lignes d'une demande (toutes, un endpoint, une cible, une image, un code source). */
async function markScope(input: ScanScope, state: 'queued' | null): Promise<void> {
  const now = new Date()
  const set = { scanState: state, scanStateAt: state ? now : null }
  let endpointId = input.endpointId
  if (input.targetId && !endpointId) {
    const [t] = await db().select({ endpointId: schema.projectTargets.endpointId }).from(schema.projectTargets).where(eq(schema.projectTargets.id, input.targetId))
    endpointId = t?.endpointId
  }
  // Fin d'analyse : seules les lignes encore marquées sont remises à zéro (pas celles d'une analyse suivante déjà en file).
  const only = state ? [] : [isNotNull(schema.imageScans.scanState)]
  if (!input.sourceOnly) {
    const rows = await db().select({ id: schema.imageScans.id, targets: schema.imageScans.targets, imageId: schema.imageScans.imageId }).from(schema.imageScans)
      .where(and(...(endpointId ? [eq(schema.imageScans.endpointId, endpointId)] : []), ...only))
    const ids = rows.filter(r => (!input.imageId || r.imageId === input.imageId) && (!input.targetId || r.targets.some(t => t.targetId === input.targetId))).map(r => r.id)
    if (ids.length) await db().update(schema.imageScans).set(set).where(inArray(schema.imageScans.id, ids))
  }
  if (!input.imageId) {
    const targets = input.targetId
      ? [input.targetId]
      : (await db().select({ id: schema.projectTargets.id }).from(schema.projectTargets).where(endpointId ? eq(schema.projectTargets.endpointId, endpointId) : undefined)).map(t => t.id)
    if (targets.length) await db().update(schema.sourceScans).set(set).where(inArray(schema.sourceScans.targetId, targets))
  }
}

/** Une analyse marquée depuis plus de 2 h est considérée comme interrompue (worker arrêté…). */
const liveState = (state: 'queued' | 'running' | null, at: Date | null) => (state && at && Date.now() - at.getTime() < 2 * 3600_000 ? state : null)

/** AC supplémentaires de la console (NODE_EXTRA_CA_CERTS), transmises à Trivy. */
export async function extraCa(): Promise<string | null> {
  const path = process.env.NODE_EXTRA_CA_CERTS
  return path ? readFile(path, 'utf8').catch(() => null) : null
}

interface ScanItem { image: string, imageId: string, targets: Map<string, { targetId: string, projectId: string, label: string, services: Set<string> }> }

/** Images à analyser sur un endpoint : conteneurs en marche (gérés par la console, ou tous). */
async function imagesOf(row: { ep: typeof schema.serverEndpoints.$inferSelect, server: typeof schema.portainerServers.$inferSelect }, scope: TrivySettings['scope'], targetId?: string): Promise<ScanItem[]> {
  const conn = await connectionFor(row.server)
  const containers = (await portainer().listContainers(conn, row.ep.portainerEndpointId)).filter(c => c.state === 'running')
  const targets = await db().select({ id: schema.projectTargets.id, stack: schema.projectTargets.stackName, projectId: schema.projects.id, project: schema.projects.name, env: schema.environments.name })
    .from(schema.projectTargets)
    .innerJoin(schema.projects, eq(schema.projects.id, schema.projectTargets.projectId))
    .innerJoin(schema.environments, eq(schema.environments.id, schema.projectTargets.environmentId))
    .where(eq(schema.projectTargets.endpointId, row.ep.id))
  const byStack = new Map(targets.filter(t => t.stack).map(t => [t.stack!, t]))
  const items = new Map<string, ScanItem>()
  for (const c of containers) {
    const stack = c.labels['com.docker.compose.project']
    const t = stack ? byStack.get(stack) : undefined
    if (targetId ? t?.id !== targetId : scope === 'managed' && !t) continue
    const key = c.imageId ?? c.image
    const item = items.get(key) ?? { image: c.image, imageId: key, targets: new Map() }
    if (t) {
      const e = item.targets.get(t.id) ?? { targetId: t.id, projectId: t.projectId, label: `${t.project} (${t.env})`, services: new Set<string>() }
      e.services.add(c.labels['com.docker.compose.service'] ?? c.names[0] ?? c.id.slice(0, 12))
      item.targets.set(t.id, e)
    }
    items.set(key, item)
  }
  return [...items.values()]
}

/** Cibles d'une image : les précédentes encore déployées, plus celles de l'analyse en cours. */
export async function mergeScanTargets(previous: readonly ImageScanDto['targets'][number][], added: readonly ImageScanDto['targets'][number][]): Promise<ImageScanDto['targets']> {
  const ids = previous.map(t => t.targetId).filter(id => !added.some(a => a.targetId === id))
  const alive = ids.length
    ? new Set((await db().select({ id: schema.projectTargets.id }).from(schema.projectTargets).where(and(inArray(schema.projectTargets.id, ids), isNotNull(schema.projectTargets.currentReleaseId)))).map(r => r.id))
    : new Set<string>()
  return [...previous.filter(t => alive.has(t.targetId)), ...added]
}

/**
 * Image d'une ligne de la page Vulnérabilités, parmi les conteneurs en marche : même empreinte,
 * sinon la même référence ou les mêmes services (image remplacée depuis : nouvelle version,
 * tag récupéré à nouveau, Watchtower…). La ligne périmée est alors retirée au profit de la nouvelle.
 */
async function sameImage(endpointId: string, imageId: string, items: ScanItem[], run: TrivyRun): Promise<ScanItem[]> {
  const exact = items.filter(i => i.imageId === imageId)
  if (exact.length) return exact
  const [stale] = await db().select({ image: schema.imageScans.image, targets: schema.imageScans.targets }).from(schema.imageScans)
    .where(and(eq(schema.imageScans.endpointId, endpointId), eq(schema.imageScans.imageId, imageId)))
  if (!stale) return []
  const services = new Set(stale.targets.flatMap(t => t.services.map(s => `${t.targetId}/${s}`)))
  let found = items.filter(i => i.image === stale.image)
  if (!found.length) found = items.filter(i => [...i.targets.values()].some(t => [...t.services].some(s => services.has(`${t.targetId}/${s}`))))
  if (!found.length) return []
  await db().delete(schema.imageScans).where(and(eq(schema.imageScans.endpointId, endpointId), eq(schema.imageScans.imageId, imageId)))
  run.note = `Image remplacée depuis la dernière analyse : ${found.map(i => i.image).join(', ')} en service analysée à la place`
  return found
}

/** Origine d'une analyse (affichée dans la page Vulnérabilités). */
export interface ScanOrigin { trigger: ScanTrigger, deploymentId?: string | null }

export interface ScanOutcome { status: 'ok' | 'error', error: string | null, counts: SeverityCounts, fixable: number, findings: Finding[], os: string | null, previous: Finding[] | null }

/**
 * Analyse d'une image sur l'hôte de l'endpoint (conteneur Trivy ponctuel), résultat enregistré.
 * Une analyse en échec ne remplace pas un résultat précédent valide.
 */
export async function scanImage(conn: PortainerConnection, ep: { id: string, portainerEndpointId: number }, item: { image: string, imageId: string, targets: ImageScanDto['targets'] }, settings: TrivySettings, ca: string | null, origin: ScanOrigin): Promise<ScanOutcome> {
  const where = and(eq(schema.imageScans.endpointId, ep.id), eq(schema.imageScans.imageId, item.imageId))
  await db().update(schema.imageScans).set({ scanState: 'running', scanStateAt: new Date() }).where(where)
  const [prev] = await db().select({ findings: schema.imageScans.findings, status: schema.imageScans.status, targets: schema.imageScans.targets }).from(schema.imageScans).where(where)
  // Cibles déjà connues de l'image conservées tant qu'elles sont déployées (une image peut servir plusieurs projets).
  const targets = await mergeScanTargets(prev?.targets ?? [], item.targets)
  const base = { endpointId: ep.id, image: item.image, imageId: item.imageId, scannedAt: new Date(), targets, trigger: origin.trigger, deploymentId: origin.deploymentId ?? null }
  try {
    const r = await portainer().runOneShot(conn, ep.portainerEndpointId, {
      image: settings.image,
      entrypoint: ['sh', '-c'],
      cmd: [trivyScript(item.image, settings)],
      binds: ['/var/run/docker.sock:/var/run/docker.sock:ro', `${TRIVY_CACHE_VOLUME}:/root/.cache/trivy`],
      files: ca ? [{ path: TRIVY_EXTRA_CA, content: ca, mode: 0o644 }] : [],
      outputs: [TRIVY_OUTPUT],
      outputLimits: { maxBytes: 64 * 1024 * 1024, maxFiles: 1 },
      labels: { 'platform.role': 'trivy' },
      timeoutMs: (settings.timeoutMin + 2) * 60_000,
      memoryMb: 2048,
      networkMode: 'bridge',
    })
    const report = r.outputs[TRIVY_OUTPUT]?.[0]?.content
    if (r.exitCode !== 0 || !report) throw new Error(r.logs.filter(l => /FATAL|ERROR/.test(l)).slice(-2).join(' ').slice(0, 500) || `Trivy terminé avec le code ${r.exitCode}`)
    const parsed = parseTrivyReport(report)
    const values = { ...base, status: 'ok' as const, error: null, os: parsed.os, counts: parsed.counts, fixable: parsed.fixable, findings: parsed.findings, sourceUrl: parsed.sourceUrl, imageVersion: parsed.imageVersion, scanState: null, scanStateAt: null }
    await db().insert(schema.imageScans).values(values).onConflictDoUpdate({ target: [schema.imageScans.endpointId, schema.imageScans.imageId], set: values })
    return { ...values, previous: prev?.status === 'ok' ? prev.findings : null }
  }
  catch (err) {
    const error = (err as Error).message.slice(0, 500)
    const values = { ...base, status: 'error' as const, error, os: null, counts: emptyCounts(), fixable: 0, findings: [], scanState: null, scanStateAt: null }
    if (prev?.status === 'ok') await db().update(schema.imageScans).set({ error, targets, scanState: null, scanStateAt: null }).where(where)
    else await db().insert(schema.imageScans).values(values).onConflictDoUpdate({ target: [schema.imageScans.endpointId, schema.imageScans.imageId], set: values })
    return { ...values, previous: null }
  }
}

/**
 * Dépendances du code source d'une release (Trivy « fs » sur son dossier source, sur l'hôte),
 * résultat enregistré pour la cible. Une analyse en échec ne remplace pas un résultat valide.
 */
export async function scanSource(conn: PortainerConnection, ep: { portainerEndpointId: number }, input: { targetId: string, releaseId: string, sourceDir: string }, settings: TrivySettings, ca: string | null, origin: ScanOrigin): Promise<ScanOutcome & { manifests: string[] }> {
  const [prev] = await db().select({ findings: schema.sourceScans.findings, status: schema.sourceScans.status }).from(schema.sourceScans).where(eq(schema.sourceScans.targetId, input.targetId))
  await db().update(schema.sourceScans).set({ scanState: 'running', scanStateAt: new Date() }).where(eq(schema.sourceScans.targetId, input.targetId))
  const base = { targetId: input.targetId, releaseId: input.releaseId, scannedAt: new Date(), trigger: origin.trigger, deploymentId: origin.deploymentId ?? null }
  try {
    const r = await portainer().runOneShot(conn, ep.portainerEndpointId, {
      image: settings.image,
      entrypoint: ['sh', '-c'],
      cmd: [trivyScript({ source: true }, settings)],
      binds: [`${input.sourceDir}:${TRIVY_SOURCE_DIR}:ro`, `${TRIVY_CACHE_VOLUME}:/root/.cache/trivy`],
      files: ca ? [{ path: TRIVY_EXTRA_CA, content: ca, mode: 0o644 }] : [],
      outputs: [TRIVY_OUTPUT],
      outputLimits: { maxBytes: 64 * 1024 * 1024, maxFiles: 1 },
      labels: { 'platform.role': 'trivy' },
      timeoutMs: (settings.timeoutMin + 2) * 60_000,
      memoryMb: 2048,
      networkMode: 'bridge',
    })
    const report = r.outputs[TRIVY_OUTPUT]?.[0]?.content
    if (r.exitCode !== 0 || !report) throw new Error(r.logs.filter(l => /FATAL|ERROR/.test(l)).slice(-2).join(' ').slice(0, 500) || `Trivy terminé avec le code ${r.exitCode}`)
    const parsed = parseTrivyReport(report)
    const values = { ...base, status: 'ok' as const, error: null, counts: parsed.counts, fixable: parsed.fixable, findings: parsed.findings, manifests: parsed.targets, scanState: null, scanStateAt: null }
    await db().insert(schema.sourceScans).values(values).onConflictDoUpdate({ target: schema.sourceScans.targetId, set: values })
    return { ...values, os: null, previous: prev?.status === 'ok' ? prev.findings : null }
  }
  catch (err) {
    const error = (err as Error).message.slice(0, 500)
    const values = { ...base, status: 'error' as const, error, counts: emptyCounts(), fixable: 0, findings: [], manifests: [], scanState: null, scanStateAt: null }
    if (prev?.status === 'ok') await db().update(schema.sourceScans).set({ error, scanState: null, scanStateAt: null }).where(eq(schema.sourceScans.targetId, input.targetId))
    else await db().insert(schema.sourceScans).values(values).onConflictDoUpdate({ target: schema.sourceScans.targetId, set: values })
    return { ...values, os: null, previous: null }
  }
}

/** Dossier source de la release active d'une cible sur son hôte (null si purgée ou absente). */
async function activeSource(t: { id: string, projectSlug: string, projectPath: string | null, endpointId: string, environmentId: string, currentReleaseId: string }): Promise<{ releaseId: string, sourceDir: string } | null> {
  const [rel] = await db().select({ id: schema.releases.id, slug: schema.releases.slug, purgedAt: schema.releases.purgedAt }).from(schema.releases).where(eq(schema.releases.id, t.currentReleaseId))
  const [paths] = await db().select().from(schema.pathConfigs).where(and(eq(schema.pathConfigs.endpointId, t.endpointId), eq(schema.pathConfigs.environmentId, t.environmentId)))
  if (!rel?.slug || rel.purgedAt || !paths) return null
  const sourceDir = projectLayout(paths, t.projectSlug, t.projectPath).release(rel.slug).sourceDir
  // Docker créerait un dossier absent à monter : vérifié d'abord par le Runner.
  const runner = await runnerFor(t.endpointId)
  const exists = (await runner.pathExists({ requestId: crypto.randomUUID(), actor: 'trivy' }, { path: sourceDir }).catch(() => ({ exists: false }))).exists
  return exists ? { releaseId: rel.id, sourceDir } : null
}

/** Analyse : endpoints actifs (ou un seul), images de leurs conteneurs ; une image à la fois. */
export async function runTrivyScan(input: { endpointId?: string, targetId?: string, imageId?: string, sourceOnly?: boolean, trigger?: string, deploy?: DeployScanScope }): Promise<TrivyRun> {
  const settings = await trivySettings()
  let endpointId = input.endpointId
  if (input.targetId) {
    const [t] = await db().select({ endpointId: schema.projectTargets.endpointId }).from(schema.projectTargets).where(eq(schema.projectTargets.id, input.targetId))
    endpointId = t?.endpointId
  }
  const rows = await db().select({ ep: schema.serverEndpoints, server: schema.portainerServers }).from(schema.serverEndpoints)
    .innerJoin(schema.portainerServers, eq(schema.portainerServers.id, schema.serverEndpoints.serverId))
    .where(endpointId ? eq(schema.serverEndpoints.id, endpointId) : and(eq(schema.serverEndpoints.enabled, true), eq(schema.serverEndpoints.missing, false)))
  const run: TrivyRun = { running: true, trigger: input.trigger ?? 'manuelle', startedAt: new Date().toISOString(), finishedAt: null, total: 0, done: 0, failed: 0, current: null }
  const origin: ScanOrigin = input.deploy ? { trigger: 'deploy', deploymentId: input.deploy.deploymentId } : { trigger: input.trigger === 'planifiée' ? 'planned' : 'manual' }
  await saveRun(run)
  const ca = await extraCa()
  const fresh: { label: string, image: string, server: string, findings: Finding[] }[] = []
  try {
    for (const row of rows) {
      let items: ScanItem[]
      try {
        // Une seule image (empreinte), ou aucune pour le seul code source d'une cible.
        items = input.sourceOnly ? [] : await imagesOf(row, input.imageId ? 'all' : settings.scope, input.targetId)
        if (input.imageId) items = await sameImage(row.ep.id, input.imageId, items, run)
        // Après un déploiement : seulement les services déployés (selon les réglages d'analyse avant déploiement).
        const d = input.deploy
        if (d) items = items.filter(i => [...i.targets.values()].some(t => t.targetId === input.targetId && [...t.services].some(s => d.services.includes(s))))
      }
      catch (err) {
        run.failed++
        run.lastError ??= `${row.server.name} : ${(err as Error).message}`
        console.warn(`[trivy] ${row.server.name} : ${(err as Error).message}`)
        continue
      }
      run.total += items.length
      await saveRun(run)
      const conn = await connectionFor(row.server)
      for (const item of items) {
        run.current = `${row.server.name} · ${item.image}`
        await saveRun(run)
        const targets = [...item.targets.values()].map(t => ({ ...t, services: [...t.services].sort(byCode) }))
        const d = input.deploy
        const reused = d ? await reuseRecentScan(row.ep.id, item.imageId, targets, d) : null
        if (reused) {
          run.done++
          continue
        }
        const r = await scanImage(conn, row.ep, { image: item.image, imageId: item.imageId, targets }, settings, ca, origin)
        if (r.status === 'error') {
          run.failed++
          run.lastError ??= `${item.image} : ${r.error}`
        }
        else if (settings.notifyMin !== 'off') {
          const added = newFindings(r.previous, r.findings, settings.notifyMin)
          if (added.length) fresh.push({ label: targets.map(t => t.label).join(', ') || item.image, image: item.image, server: row.server.name, findings: added })
        }
        run.done++
      }
      // Dépendances du code source des releases actives (cibles gérées de l'endpoint).
      if (settings.sourceScan && !input.imageId && (input.deploy?.source ?? true)) {
        const targets = await db().select({ id: schema.projectTargets.id, projectSlug: schema.projects.slug, projectPath: schema.projectTargets.projectPath, endpointId: schema.projectTargets.endpointId, environmentId: schema.projectTargets.environmentId, currentReleaseId: schema.projectTargets.currentReleaseId, project: schema.projects.name, env: schema.environments.name, archivedAt: schema.projects.archivedAt })
          .from(schema.projectTargets)
          .innerJoin(schema.projects, eq(schema.projects.id, schema.projectTargets.projectId))
          .innerJoin(schema.environments, eq(schema.environments.id, schema.projectTargets.environmentId))
          .where(and(eq(schema.projectTargets.endpointId, row.ep.id), isNotNull(schema.projectTargets.currentReleaseId), ...(input.targetId ? [eq(schema.projectTargets.id, input.targetId)] : [])))
        for (const t of targets.filter(x => !x.archivedAt)) {
          const src = await activeSource({ ...t, currentReleaseId: t.currentReleaseId! }).catch(() => null)
          if (!src) continue
          run.total++
          run.current = `${row.server.name} · code source de ${t.project} (${t.env})`
          await saveRun(run)
          const r = await scanSource(conn, row.ep, { targetId: t.id, ...src }, settings, ca, origin)
          if (r.status === 'error') run.failed++
          else if (settings.notifyMin !== 'off') {
            const added = newFindings(r.previous, r.findings, settings.notifyMin)
            if (added.length) fresh.push({ label: `${t.project} (${t.env})`, image: 'code source', server: row.server.name, findings: added })
          }
          run.done++
        }
      }
      // Analyse complète d'un endpoint : images qui ne tournent plus retirées.
      if (!input.targetId && !input.imageId) {
        const kept = items.map(i => i.imageId)
        await db().delete(schema.imageScans).where(and(eq(schema.imageScans.endpointId, row.ep.id), ...(kept.length ? [notInArray(schema.imageScans.imageId, kept)] : [])))
      }
      // Analyse suivant un déploiement : une mise à niveau a pu remplacer les images pendant l'analyse ; seules celles de la release active restent.
      if (input.deploy && input.targetId) {
        const [cur] = await db().select({ images: schema.releases.images }).from(schema.projectTargets)
          .innerJoin(schema.releases, eq(schema.releases.id, schema.projectTargets.currentReleaseId))
          .where(eq(schema.projectTargets.id, input.targetId))
        if (cur) await pruneTargetScans(row.ep.id, input.targetId, Object.values(cur.images as Record<string, string>))
      }
    }
  }
  finally {
    // Lignes de cette demande restées marquées (image arrêtée entre-temps…) : remises à zéro.
    await markScope(input, null).catch(() => {})
    run.running = false
    run.current = null
    if (!run.total && !run.failed) {
      run.note = input.imageId
        ? 'Image introuvable parmi les conteneurs en marche, ni par son empreinte, ni par sa référence, ni par ses services : rien à analyser'
        : settings.scope === 'managed' ? 'Aucun conteneur géré par la console en marche : rien à analyser (périmètre « conteneurs gérés »)' : 'Aucun conteneur en marche : rien à analyser'
    }
    run.finishedAt = new Date().toISOString()
    await saveRun(run)
  }
  // Demandes de correction : résolues si l'analyse ne relève plus leurs vulnérabilités.
  await markResolvedRequests().catch(err => console.warn(`[remediation] ${(err as Error).message}`))
  if (fresh.length) {
    const total = fresh.reduce((n, f) => n + f.findings.length, 0)
    await emitNotification({
      event: 'vulnerability.found',
      severity: fresh.some(f => f.findings.some(x => x.severity === 'CRITICAL')) ? 'error' : 'warning',
      title: `Trivy : ${total} nouvelle(s) vulnérabilité(s) ${settings.notifyMin === 'CRITICAL' ? 'critique(s)' : 'critique(s) ou haute(s)'}`,
      summary: fresh.slice(0, 15).map(f => `${f.label} — ${f.image} (${f.server}) : ${f.findings.slice(0, 5).map(x => `${x.id} ${x.pkg}${x.fixed ? ` → ${x.fixed}` : ''}`).join(', ')}${f.findings.length > 5 ? '…' : ''}`).join('\n'),
      facts: [{ label: 'Images concernées', value: String(fresh.length) }, { label: 'Analyse', value: run.trigger }],
      path: '/vulnerabilities',
    })
  }
  return run
}

const toDto = (r: typeof schema.imageScans.$inferSelect, names: Map<string, { server: string, endpoint: string }>): ImageScanDto => ({
  id: r.id,
  endpointId: r.endpointId,
  serverName: names.get(r.endpointId)?.server ?? '?',
  endpointName: names.get(r.endpointId)?.endpoint ?? '?',
  image: r.image,
  imageId: r.imageId,
  scannedAt: r.scannedAt.toISOString(),
  status: r.status,
  error: r.error,
  os: r.os,
  counts: r.counts,
  fixable: r.fixable,
  targets: r.targets,
  sourceUrl: r.sourceUrl,
  trigger: r.trigger,
  deploymentId: r.deploymentId,
  imageVersion: r.imageVersion,
  scanState: liveState(r.scanState, r.scanStateAt),
})

async function endpointNames(ids: string[]) {
  if (!ids.length) return new Map<string, { server: string, endpoint: string }>()
  const rows = await db().select({ id: schema.serverEndpoints.id, endpoint: schema.serverEndpoints.name, server: schema.portainerServers.name }).from(schema.serverEndpoints)
    .innerJoin(schema.portainerServers, eq(schema.portainerServers.id, schema.serverEndpoints.serverId)).where(inArray(schema.serverEndpoints.id, ids))
  return new Map(rows.map(r => [r.id, { server: r.server, endpoint: r.endpoint }]))
}

export async function listImageScans(endpointIds: string[]): Promise<ImageScanDto[]> {
  if (!endpointIds.length) return []
  const rows = await db().select().from(schema.imageScans).where(inArray(schema.imageScans.endpointId, endpointIds))
  const names = await endpointNames([...new Set(rows.map(r => r.endpointId))])
  const score = (d: ImageScanDto) => d.counts.CRITICAL * 1e6 + d.counts.HIGH * 1e3 + d.counts.MEDIUM
  return rows.map(r => toDto(r, names)).sort((a, b) => score(b) - score(a) || a.image.localeCompare(b.image))
}

export async function imageScanDetail(id: string): Promise<(ImageScanDto & { findings: Finding[] }) | null> {
  const [r] = await db().select().from(schema.imageScans).where(eq(schema.imageScans.id, id))
  if (!r) return null
  return { ...toDto(r, await endpointNames([r.endpointId])), findings: r.findings }
}

export async function targetImageScans(targetId: string, endpointId: string): Promise<(ImageScanDto & { findings: Finding[] })[]> {
  const rows = (await db().select().from(schema.imageScans).where(eq(schema.imageScans.endpointId, endpointId))).filter(r => r.targets.some(t => t.targetId === targetId))
  const names = await endpointNames([endpointId])
  return rows.map(r => ({ ...toDto(r, names), findings: r.findings }))
}

const sourceDto = (r: { s: typeof schema.sourceScans.$inferSelect, projectId: string, project: string, env: string, server: string, repository: string | null, ref: string | null, commitSha: string | null, release: string | null }): SourceScanDto => ({
  id: r.s.id,
  targetId: r.s.targetId,
  projectId: r.projectId,
  label: `${r.project} (${r.env})`,
  serverName: r.server,
  repository: r.repository,
  ref: r.ref,
  commitSha: r.commitSha,
  release: r.release,
  scannedAt: r.s.scannedAt.toISOString(),
  status: r.s.status,
  error: r.s.error,
  counts: r.s.counts,
  fixable: r.s.fixable,
  manifests: r.s.manifests,
  trigger: r.s.trigger,
  deploymentId: r.s.deploymentId,
  scanState: liveState(r.s.scanState, r.s.scanStateAt),
})

function sourceQuery() {
  return db().select({ s: schema.sourceScans, projectId: schema.projects.id, project: schema.projects.name, env: schema.environments.name, server: schema.portainerServers.name, repository: schema.releases.repository, ref: schema.releases.sourceRef, commitSha: schema.releases.commitSha, release: schema.releases.slug, endpointId: schema.projectTargets.endpointId })
    .from(schema.sourceScans)
    .innerJoin(schema.projectTargets, eq(schema.projectTargets.id, schema.sourceScans.targetId))
    .innerJoin(schema.projects, eq(schema.projects.id, schema.projectTargets.projectId))
    .innerJoin(schema.environments, eq(schema.environments.id, schema.projectTargets.environmentId))
    .innerJoin(schema.serverEndpoints, eq(schema.serverEndpoints.id, schema.projectTargets.endpointId))
    .innerJoin(schema.portainerServers, eq(schema.portainerServers.id, schema.serverEndpoints.serverId))
    .leftJoin(schema.releases, eq(schema.releases.id, schema.sourceScans.releaseId))
}

export async function listSourceScans(endpointIds: string[]): Promise<SourceScanDto[]> {
  if (!endpointIds.length) return []
  const rows = await sourceQuery().where(inArray(schema.projectTargets.endpointId, endpointIds))
  const score = (d: SourceScanDto) => d.counts.CRITICAL * 1e6 + d.counts.HIGH * 1e3 + d.counts.MEDIUM
  return rows.map(sourceDto).sort((a, b) => score(b) - score(a) || a.label.localeCompare(b.label))
}

export async function sourceScanDetail(id: string): Promise<(SourceScanDto & { endpointId: string, findings: Finding[] }) | null> {
  const [r] = await sourceQuery().where(eq(schema.sourceScans.id, id))
  return r ? { ...sourceDto(r), endpointId: r.endpointId, findings: r.s.findings } : null
}

export async function targetSourceScan(targetId: string): Promise<(SourceScanDto & { findings: Finding[] }) | null> {
  const [r] = await sourceQuery().where(eq(schema.sourceScans.targetId, targetId))
  return r ? { ...sourceDto(r), findings: r.s.findings } : null
}


/** Version de Trivy en service et dernière publiée sur Docker Hub. */
export async function trivyEngine(): Promise<TrivyEngineDto> {
  const { image } = await trivySettings()
  const colon = image.lastIndexOf(':')
  const repository = image.slice(0, colon)
  const tag = image.slice(colon + 1)
  let latest: string | null = null
  let latestError: string | null = null
  try {
    latest = latestStableTag(await listTags(parseImageRef(`${repository}:${tag}`)!, 5000))
  }
  catch (err) {
    latestError = (err as Error).message
  }
  const newer = (a: string, b: string) => {
    const pa = a.replace(/^v/, '').split('.').map(Number)
    const pb = b.replace(/^v/, '').split('.').map(Number)
    for (let i = 0; i < 3; i++) if ((pa[i] ?? 0) !== (pb[i] ?? 0)) return (pa[i] ?? 0) > (pb[i] ?? 0)
    return false
  }
  return { image, repository, tag, latest, latestError, updateAvailable: !!latest && newer(latest, tag) }
}

/** Passage de Trivy à une version publiée (dépôt d'origine conservé) ; récupérée à la prochaine analyse. */
export async function updateTrivyEngine(tag: string, userId: string | null): Promise<TrivyEngineDto> {
  const settings = await trivySettings()
  const repository = settings.image.slice(0, settings.image.lastIndexOf(':'))
  if (!/^v?\d+\.\d+\.\d+$/.test(tag)) throw createError({ statusCode: 422, statusMessage: 'Version attendue (ex. 0.68.0)' })
  const tags = await listTags(parseImageRef(`${repository}:${tag}`)!, 5000).catch((err: Error) => {
    throw createError({ statusCode: 422, statusMessage: `Versions de ${repository} illisibles : ${err.message}` })
  })
  if (!tags.includes(tag)) throw createError({ statusCode: 422, statusMessage: `${repository}:${tag} n'est pas publiée` })
  await saveTrivySettings({ ...settings, image: `${repository}:${tag}` }, userId)
  return trivyEngine()
}

/**
 * Image mise à jour : les détections des images que la cible n'utilise plus sont retirées. La cible
 * est détachée de leurs analyses, supprimées quand plus aucun projet ne les utilise ; pour une même
 * image republiée (nouvelle empreinte), seule l'analyse la plus récente est gardée.
 */
export async function pruneTargetScans(endpointId: string, targetId: string, currentImages: readonly string[]): Promise<number> {
  const norm = (i: string) => normalizeImage(i)
  const current = new Set(currentImages.map(norm))
  const rows = (await db().select({ id: schema.imageScans.id, image: schema.imageScans.image, targets: schema.imageScans.targets, scannedAt: schema.imageScans.scannedAt }).from(schema.imageScans).where(eq(schema.imageScans.endpointId, endpointId)))
    .filter(r => r.targets.some(t => t.targetId === targetId))
  const newest = new Map<string, string>()
  for (const r of [...rows].sort((a, b) => b.scannedAt.getTime() - a.scannedAt.getTime())) if (!newest.has(norm(r.image))) newest.set(norm(r.image), r.id)
  let removed = 0
  for (const r of rows) {
    if (current.has(norm(r.image)) && newest.get(norm(r.image)) === r.id) continue
    const targets = r.targets.filter(t => t.targetId !== targetId)
    if (targets.length) await db().update(schema.imageScans).set({ targets }).where(eq(schema.imageScans.id, r.id))
    else await db().delete(schema.imageScans).where(eq(schema.imageScans.id, r.id))
    removed++
  }
  return removed
}

/**
 * Nettoyage des analyses (page Vulnérabilités) : images arrêtées, analyses plus anciennes d'une même
 * image, échecs, code source des cibles sans release active, ou tout. Les analyses retirées sont
 * refaites à la prochaine analyse ; les demandes de correction sont conservées.
 */
export async function cleanupScans(input: ScanCleanupInput): Promise<ScanCleanupResult> {
  const rows = await db().select({ id: schema.imageScans.id, endpointId: schema.imageScans.endpointId, image: schema.imageScans.image, imageId: schema.imageScans.imageId, status: schema.imageScans.status, scannedAt: schema.imageScans.scannedAt }).from(schema.imageScans)
  const reasons = { stale: new Set<string>(), duplicates: new Set<string>(), failed: new Set<string>() }
  const unreachable: string[] = []
  if (input.failed) for (const r of rows.filter(x => x.status === 'error')) reasons.failed.add(r.id)
  if (input.duplicates) {
    const newest = new Set<string>()
    for (const r of [...rows].sort((a, b) => b.scannedAt.getTime() - a.scannedAt.getTime())) {
      const key = `${r.endpointId}|${normalizeImage(r.image)}`
      if (newest.has(key)) reasons.duplicates.add(r.id)
      else newest.add(key)
    }
  }
  if (input.stale && rows.length) {
    const endpointIds = [...new Set(rows.map(r => r.endpointId))]
    const eps = await db().select({ ep: schema.serverEndpoints, server: schema.portainerServers }).from(schema.serverEndpoints)
      .innerJoin(schema.portainerServers, eq(schema.portainerServers.id, schema.serverEndpoints.serverId))
      .where(inArray(schema.serverEndpoints.id, endpointIds))
    for (const id of endpointIds) {
      const mine = rows.filter(r => r.endpointId === id)
      const row = eps.find(e => e.ep.id === id)
      // Endpoint retiré, désactivé ou disparu : ses images ne sont plus suivies.
      if (!row || !row.ep.enabled || row.ep.missing) {
        for (const r of mine) reasons.stale.add(r.id)
        continue
      }
      let running: { imageId?: string | null, image: string }[]
      try {
        running = (await portainer().listContainers(await connectionFor(row.server), row.ep.portainerEndpointId)).filter(c => c.state === 'running')
      }
      catch {
        unreachable.push(`${row.server.name} / ${row.ep.name}`)
        continue
      }
      const ids = new Set(running.map(c => c.imageId).filter(Boolean))
      const refs = new Set(running.map(c => normalizeImage(c.image)))
      for (const r of mine) if (!ids.has(r.imageId) && !refs.has(normalizeImage(r.image))) reasons.stale.add(r.id)
    }
  }
  const imageIds = input.all ? rows.map(r => r.id) : [...new Set([...reasons.stale, ...reasons.duplicates, ...reasons.failed])]

  const pt = schema.projectTargets
  const sourceRows = input.all || input.sources
    ? await db().select({ id: schema.sourceScans.id }).from(schema.sourceScans)
        .innerJoin(pt, eq(pt.id, schema.sourceScans.targetId))
        .innerJoin(schema.projects, eq(schema.projects.id, pt.projectId))
        .where(input.all ? undefined : or(isNull(pt.currentReleaseId), isNotNull(schema.projects.archivedAt)))
    : []
  const sourceIds = sourceRows.map(r => r.id)

  if (!input.dryRun) {
    if (imageIds.length) await db().delete(schema.imageScans).where(inArray(schema.imageScans.id, imageIds))
    if (sourceIds.length) await db().delete(schema.sourceScans).where(inArray(schema.sourceScans.id, sourceIds))
  }
  return {
    images: imageIds.length,
    sources: sourceIds.length,
    byReason: { stale: reasons.stale.size, duplicates: reasons.duplicates.size, failed: reasons.failed.size, sources: input.sources || input.all ? sourceIds.length : 0 },
    unreachable,
    dryRun: input.dryRun,
  }
}

/**
 * Analyse récente de la même image (même empreinte) reprise au déploiement : rattachée au
 * déploiement et au projet, sans nouvelle analyse. Null si aucune n'est assez récente.
 */
export async function reuseRecentScan(endpointId: string, imageId: string, targets: ImageScanDto['targets'], d: Pick<DeployScanScope, 'deploymentId' | 'reuseMs'>): Promise<(typeof schema.imageScans.$inferSelect) | null> {
  const [recent] = await db().select().from(schema.imageScans).where(and(eq(schema.imageScans.endpointId, endpointId), eq(schema.imageScans.imageId, imageId), eq(schema.imageScans.status, 'ok')))
  if (!recent || recent.error !== null || Date.now() - recent.scannedAt.getTime() >= d.reuseMs) return null
  await db().update(schema.imageScans).set({ targets: await mergeScanTargets(recent.targets, targets), trigger: 'deploy', deploymentId: d.deploymentId }).where(eq(schema.imageScans.id, recent.id))
  return recent
}
