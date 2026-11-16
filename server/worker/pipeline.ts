/**
 * Pipeline des déploiements (§8, §13), exécuté par le worker.
 *
 * deploy  : fichiers → revalidation → build → Compose final → docker compose (agent) →
 *           healthchecks → activation (ou rollback automatique) → rétention
 * stop / start / restart / delete : actions de cycle de vie sur la stack.
 *
 * Chaque étape fait avancer le statut selon la machine d'états partagée ;
 * tout est journalisé (masquage des secrets compris).
 */
import { audit } from '../utils/audit'
import { finishProjectDeletion } from '../services/project-removal'
import { and, desc, eq, inArray, isNotNull, isNull } from 'drizzle-orm'
import type { DeploymentStatus } from '../../shared/utils/deployment-status'
import { assertTransition } from '../../shared/utils/deployment-status'
import { formatBytes, formatDuration } from '../../shared/utils/format'
import { releaseSlug } from '../../shared/utils/release'
import type { PortainerConnection } from '../adapters/portainer'
import { portainer } from '../adapters/portainer'
import { type TargetRunner, runnerFor } from '../adapters/runner'
import { db, schema } from '../db/client'
import type { AnalysisResult, PortApproval } from '../lib/compose/analyze'
import { waitForStack } from '../services/healthcheck'
import { recordBaseline, watchtowerStackEnv } from '../services/watchtower'
import { ensureProfileApplied, getProfileOr404 } from '../services/watchtower-profiles'
import { watchtowerConfig } from '../../shared/schemas/watchtower'
import { type LogLevel, appendLogs } from '../services/logs'
import { normalizeImage } from '../lib/compose/image-upgrade'
import YAML from 'yaml'
import { bakeImageOverrides } from '../services/image-upgrade'
import { configFileOf, dumpScript, pgLayout, preloadOptions, restoreScript } from '../lib/pg-migration'
import { aliasPlanFromYaml, rewriteStackEnv } from '../lib/compose/unique-aliases'
import { isBenignSecret } from '../lib/network-probe'
import { composeNames, releaseSourceFiles } from '../services/release-sources'
import { mapLimit } from '../utils/pool'
import { collectItems, copyItem, layoutOn, selectedItems, sideOf } from '../services/stack-migration'
import { stackOfTarget } from '../services/diagnostic'
import { composeNetworkKeys, pinSubnet, releaseTargetSubnets } from '../services/network-pool'
import { NGINX_ACME_WEBROOT, NGINX_LOG_FORMAT_FILE, type NginxTlsFiles, nginxLogFormatConfig, nginxSiteConfig, nginxSiteFile } from '../lib/proxy/nginx-sites'
import { pack } from 'tar-stream'
import type { Finding, SeverityCounts } from '../../shared/schemas/trivy'
import { blockingFindings, extraCa, pruneTargetScans, requestTrivyScan, reuseRecentScan, scanImage, scanSource, trivySettings } from '../services/trivy'
import { markResolvedRequests } from '../services/remediation'
import { NGINX_PROXY_CERTS_DIR, certsDirOf, issueMissingAcme, nginxHandle, proxyConfigFor, pushNginxCertificates } from '../services/nginx-certificates'
import type { MigratedFrom } from '../../shared/schemas/migration'
import { availableAlternatives } from '../services/image-sources'
import { analyzeWithSubnets, buildAnalyzeContext, getTargetOr404, targetVariables } from '../services/projects'
import { resolvePending } from '../services/pending'
import { type PrepareResult, ensureProjectDirs, prepareReleaseFiles, removeReleaseDirs } from '../services/release-files'
import { connectionFor } from '../services/servers'
import { consumeUpload, getUpload, openUpload } from '../services/uploads'
import { downloadGithubArchives, getProjectSource } from '../services/sources'
import { env } from '../utils/env'
import { projectLayout } from '../utils/path-guard'
import { Redactor } from '../utils/redact'
import { trimTrailingSlashes } from '../../shared/utils/trim'

type Phase = (typeof schema.logPhase.enumValues)[number]
type Level = (typeof schema.logLevel.enumValues)[number]

const FINISHED: DeploymentStatus[] = ['HEALTHY', 'DEGRADED', 'FAILED', 'ROLLED_BACK', 'STOPPED', 'DELETED', 'CANCELLED', 'VALIDATION_FAILED']

export interface PipelineContext {
  deploymentId: string
  redactor: Redactor
  status: DeploymentStatus
  log: (phase: Phase, message: string, level?: Level, service?: string) => Promise<void>
  transition: (to: DeploymentStatus, error?: string) => Promise<void>
}

export async function createContext(deploymentId: string): Promise<PipelineContext> {
  const [row] = await db().select({ status: schema.deployments.status, startedAt: schema.deployments.startedAt }).from(schema.deployments).where(eq(schema.deployments.id, deploymentId))
  if (!row) throw new Error(`Déploiement ${deploymentId} introuvable`)
  let started = !!row.startedAt

  const ctx: PipelineContext = {
    deploymentId,
    redactor: new Redactor(),
    status: row.status,
    async log(phase, message, level = 'info', service) {
      await appendLogs(deploymentId, [{ phase, level, service, message }], ctx.redactor)
    },
    async transition(to, error) {
      assertTransition(ctx.status, to)
      const now = new Date()
      await db().update(schema.deployments).set({
        status: to,
        ...(!started ? { startedAt: now } : {}),
        ...(FINISHED.includes(to) ? { finishedAt: now } : {}),
        ...(error ? { error: ctx.redactor.redact(error) } : {}),
        ...(to === 'FAILED' ? { failedFrom: ctx.status } : {}),
      }).where(eq(schema.deployments.id, deploymentId))
      started = true
      ctx.status = to
      await ctx.log('system', `Statut : ${to}`, to === 'FAILED' ? 'error' : to === 'DEGRADED' ? 'warn' : 'info')
    },
  }
  return ctx
}

/** Contexte complet d'un déploiement, chargé une fois au début du job. */
async function loadJob(deploymentId: string) {
  const [d] = await db().select().from(schema.deployments).where(eq(schema.deployments.id, deploymentId))
  if (!d) throw new Error(`Déploiement ${deploymentId} introuvable`)
  const t = await getTargetOr404(d.targetId)
  const [paths] = await db().select().from(schema.pathConfigs)
    .where(and(eq(schema.pathConfigs.endpointId, t.endpoint.id), eq(schema.pathConfigs.environmentId, t.env.id)))
  const [release] = d.releaseId ? await db().select().from(schema.releases).where(eq(schema.releases.id, d.releaseId)) : []
  const [server] = await db().select().from(schema.portainerServers).where(eq(schema.portainerServers.id, t.server.id))
  return { d, ...t, paths, release, serverRow: server! }
}
type Job = Awaited<ReturnType<typeof loadJob>>


const msg = (err: unknown) => (err instanceof Error ? err.message : String(err))

// ---------------------------------------------------------------------------
// Étapes du déploiement
// ---------------------------------------------------------------------------

interface GithubMeta {
  commit?: { sha: string }
  submodules?: { path: string, repository: string, sha: string }[]
  stripPrefix?: string | null
  submoduleUploads?: { path: string, uploadId: string, stripPrefix: string | null }[]
}

/** Release GitHub : archive du commit figé (et des sous-modules) téléchargée au premier passage. */
async function ensureGithubArchives(ctx: PipelineContext, job: Job) {
  const release = job.release!
  const meta = ((release.metadata as { github?: GithubMeta }).github) ?? {}
  const main = release.uploadId ? await getUpload(release.uploadId) : undefined
  const intact = !!release.sourceTreeSha256
  if (main && (!main.consumedAt || intact)) return meta
  const source = await getProjectSource(job.project.id)
  if (!source) throw new Error('Source GitHub du projet introuvable')
  const dl = await downloadGithubArchives(source, release.commitSha!, (meta.submodules ?? []).map(sm => ({ ...sm, supported: true })), m => ctx.log('extraction', m))
  const next: GithubMeta = {
    ...meta,
    stripPrefix: dl.main.report.rootFolder,
    submoduleUploads: dl.subs.map(x => ({ path: x.path, uploadId: x.upload.id, stripPrefix: x.upload.report.rootFolder })),
  }
  await db().update(schema.releases).set({ uploadId: dl.main.id, archiveSha256: dl.main.sha256, metadata: { ...(release.metadata as object), github: next } }).where(eq(schema.releases.id, release.id))
  release.uploadId = dl.main.id
  release.archiveSha256 = dl.main.sha256
  release.metadata = { ...(release.metadata as object), github: next }
  return next
}

/**
 * Erreurs du Runner (HTTP ou SSH, toutes versions) préfixées par l'action et le chemin concernés :
 * un refus sans détail (« Permission refusée… ») reste ainsi localisable dans le journal.
 */
function tracedRunner(runner: TargetRunner): TargetRunner {
  return new Proxy(runner, {
    get(target, prop, receiver) {
      const v = Reflect.get(target, prop, receiver)
      if (typeof v !== 'function' || prop === 'health') return v
      return async (...args: unknown[]) => {
        try {
          return await v.apply(target, args)
        }
        catch (err) {
          const input = (args[1] ?? {}) as { path?: string, destination?: string, archivePath?: string, contextDir?: string }
          const where = input.path ?? input.destination ?? input.archivePath ?? input.contextDir
          if (err instanceof Error && where && !err.message.includes(where)) err.message = `${String(prop)} ${where} : ${err.message}`
          throw err
        }
      }
    },
  })
}

async function prepareFiles(ctx: PipelineContext, job: Job, runner: TargetRunner): Promise<PrepareResult> {
  const { release, paths } = job
  if (!release) throw new Error('Aucune release associée au déploiement')
  if (!paths) throw new Error(`Chemins de travail non configurés pour ${job.endpoint.name} / ${job.env.name}`)
  const gh = release.sourceKind === 'github' ? await ensureGithubArchives(ctx, job) : null
  const upload = release.uploadId ? await getUpload(release.uploadId) : undefined
  if (!upload && !release.sourceTreeSha256) throw new Error('Archive de la release introuvable sur la plateforme')

  const slug = release.slug ?? releaseSlug(release.number, release.id)
  if (!release.slug) {
    await db().update(schema.releases).set({ slug }).where(eq(schema.releases.id, release.id))
    release.slug = slug
  }
  const subUploads = await Promise.all((gh?.submoduleUploads ?? []).map(async x => ({ ...x, upload: await getUpload(x.uploadId) })))
  const e = env()
  // Contexte dans le journal : révision de la console et accès aux fichiers de l'hôte.
  const h = await runner.health().catch((err: Error) => ({ error: err.message }))
  await ctx.log('extraction', 'error' in h
    ? `Console ${process.env.APP_REVISION ?? 'dev'} · accès aux fichiers de l'hôte injoignable : ${h.error}`
    : `Console ${process.env.APP_REVISION ?? 'dev'} · fichiers ${h.version === 'ssh' ? `par SSH (${h.hostname})` : `par le Runner ${h.version} sur ${h.hostname}`} · racines : ${h.roots.join(', ') || 'aucune'}`)
  const res = await prepareReleaseFiles({
    runner: tracedRunner(runner),
    ctx: { requestId: ctx.deploymentId, actor: 'worker', deploymentId: ctx.deploymentId },
    log: (m, level) => ctx.log('extraction', m, level),
    paths,
    projectSlug: job.project.slug,
    projectPath: job.target.projectPath,
    releaseSlug: slug,
    environmentKey: job.env.key,
    createdAt: release.createdAt,
    archive: {
      sizeBytes: upload?.sizeBytes ?? 0,
      sha256: upload?.sha256 ?? release.archiveSha256 ?? '',
      open: () => {
        if (!upload || upload.consumedAt) throw new Error('Archive déjà consommée et extraction précédente absente')
        return openUpload(upload)
      },
    },
    stripPrefix: gh?.stripPrefix ?? null,
    extraArchives: subUploads.filter(x => x.upload).map(x => ({
      path: x.path,
      sizeBytes: x.upload!.sizeBytes,
      sha256: x.upload!.sha256,
      stripPrefix: x.stripPrefix,
      open: () => openUpload(x.upload!),
    })),
    previousTreeSha256: release.sourceTreeSha256,
    maxFiles: e.ZIP_MAX_FILES,
    extractTimeoutSec: e.ZIP_TIMEOUT_SEC,
  })
  await db().update(schema.releases).set({
    remotePath: res.releaseDir,
    sourceTreeSha256: res.treeSha256,
    archiveSha256: upload?.sha256 ?? release.archiveSha256,
  }).where(eq(schema.releases.id, release.id))
  if (upload && !upload.consumedAt) await consumeUpload(upload.id)
  for (const x of subUploads) if (x.upload && !x.upload.consumedAt) await consumeUpload(x.upload.id)
  if (release.sourceKind === 'github') await ctx.log('extraction', `Commit déployé : ${release.repository}@${release.commitSha}`)
  return res
}

/** Revalidation avec les politiques EN VIGUEUR (elles ont pu changer depuis l'analyse). */
async function revalidate(ctx: PipelineContext, job: Job, files: ReadonlySet<string>, opts: { persist?: boolean } = {}): Promise<AnalysisResult> {
  const release = job.release!
  const approvals = ((release.analysis as { approvals?: PortApproval[] }).approvals) ?? []
  const vars = await targetVariables(job.target)
  // Valeurs publiques (projet, services, images) jamais masquées, même saisies dans une variable
  // secrète (ex. POSTGRES_USER=postgres) : sinon le journal masque le nom des services partout.
  const publicValues = new Set([job.project.slug, job.project.name, job.env.key, ...composeNames(release.composeSource ?? '')])
  for (const v of Object.values(vars)) if (v.secret && !isBenignSecret(v.value, publicValues)) ctx.redactor.add(v.value)
  // Cible relue (réglages à jour), sur l'endpoint du job (celui de destination pendant une migration).
  const fresh = await getTargetOr404(job.target.id)
  const t = { ...fresh, endpoint: job.endpoint, server: job.server, target: { ...fresh.target, endpointId: job.endpoint.id, projectPath: job.target.projectPath } }
  const analysis = await analyzeWithSubnets(t, release.composeSource ?? '', await buildAnalyzeContext(t, {
    composePath: release.composePath ?? 'compose.yml',
    files,
    releaseSlug: release.slug!,
    portApprovals: approvals,
    variables: vars,
    sourceKind: release.sourceKind === 'github' ? 'github' : 'zip',
    envFileKeys: (release.metadata as { envFileKeys?: Record<string, string[]> }).envFileKeys,
  }), opts)
  for (const i of analysis.issues.filter(x => x.severity !== 'info' || x.code === 'image.upgrade')) {
    await ctx.log('validation', `${i.service ? `[${i.service}] ` : ''}${i.message}`, i.severity === 'error' ? 'error' : 'warn', i.service)
  }
  if (!analysis.ok) throw new Error('Validation refusée avec les politiques actuelles de l\'endpoint (voir les logs de validation)')
  if (analysis.finalYaml !== release.composeFinal) {
    await ctx.log('validation', 'Le Compose final diffère de celui présenté à l\'analyse (politiques ou variables modifiées) : la version à jour est utilisée', 'warn')
    await db().update(schema.releases).set({ composeFinal: analysis.finalYaml, composeDiff: analysis.diff, images: analysis.images }).where(eq(schema.releases.id, release.id))
    release.composeFinal = analysis.finalYaml
  }
  await ctx.log('validation', `Validation conforme : ${analysis.services.length} service(s), ${analysis.builds.length} build(s), ${analysis.ports.filter(p => p.published).length} port(s) publié(s)`)
  return analysis
}

async function buildImages(ctx: PipelineContext, job: Job, runner: TargetRunner, prep: PrepareResult, analysis: AnalysisResult): Promise<Record<string, { tag: string, id: string }>> {
  const release = job.release!
  if (!analysis.builds.length) {
    await ctx.log('build', 'Aucun service à construire : images existantes utilisées')
    return {}
  }
  const health = await runner.health()
  if (!health.actions.includes('build')) throw new Error('Le Runner de cet endpoint ne peut pas construire d\'image (moteur Docker injoignable)')
  const rctx = { requestId: ctx.deploymentId, actor: 'worker', deploymentId: ctx.deploymentId }
  const images: Record<string, { tag: string, id: string }> = {}
  // Build propre (mise à niveau) : images de base récupérées à nouveau, sans cache des couches.
  const clean = !!job.d.options?.cleanBuild
  if (clean) await ctx.log('build', 'Build propre : images de base (FROM) récupérées à nouveau, sans cache')
  // Relance sans reconstruction : images de la release encore présentes sur l'hôte reprises.
  let builds = analysis.builds
  if (job.d.options?.skipBuild) {
    const present = new Set((await portainer().listImages(await connectionFor(job.serverRow), job.endpoint.portainerEndpointId)).flatMap(i => i.tags))
    for (const b of builds.filter(x => present.has(x.image))) await ctx.log('build', `Image reprise sans reconstruction : ${b.image}`, 'info', b.service)
    builds = builds.filter(x => !present.has(x.image))
    for (const b of builds) await ctx.log('build', `Image ${b.image} absente de l'hôte (supprimée par la rétention ou le nettoyage) : reconstruite`, 'warn', b.service)
    if (!builds.length) return {}
  }
  // Builds en parallèle, dans la limite du Runner (au-delà, il met les builds en file).
  const [runnerRow] = await db().select({ max: schema.targetRunners.maxConcurrentBuilds }).from(schema.targetRunners).where(eq(schema.targetRunners.endpointId, job.endpoint.id))
  const limit = Math.min(4, runnerRow?.max ?? 2)
  const t0 = Date.now()
  if (builds.length > 1) await ctx.log('build', `${builds.length} images à construire, ${Math.min(limit, builds.length)} à la fois`)
  await mapLimit(builds, limit, async (b) => {
    const contextDir = `${prep.layout.buildDir}/${release.slug}-${b.service.replace(/[^A-Za-z0-9_.-]/g, '-')}`
    await ctx.log('build', `Préparation du contexte (${b.context || '.'}) pour ${b.service}`, 'info', b.service)
    if ((await runner.pathExists(rctx, { path: contextDir })).exists) await runner.cleanup(rctx, { path: contextDir })
    try {
      const c = await runner.prepareBuildContext(rctx, { sourceDir: prep.sourceDir, subdirectory: b.context || undefined, contextDir, maxContextBytes: job.paths!.maxProjectSizeMb * 1024 * 1024 })
      await ctx.log('build', `Contexte de build : ${formatBytes(c.sizeBytes)} · Dockerfile ${b.dockerfile} · image ${b.image}`, 'info', b.service)
      const r = await runner.build(rctx, {
        contextDir,
        dockerfile: b.dockerfile,
        imageTag: b.image,
        buildArgs: b.args,
        labels: { 'platform.project': job.project.slug, 'platform.environment': job.env.key, 'platform.release': release.slug!, 'platform.service': b.service },
        target: b.target,
        timeoutSec: 1800,
        maxLogBytes: 2 * 1024 * 1024,
        pull: clean,
        noCache: clean,
      }, l => void ctx.log('build', l.line, l.stream === 'stderr' ? 'warn' : 'info', b.service))
      images[b.service] = { tag: b.image, id: r.imageId }
      await ctx.log('build', `Image construite en ${Math.round(r.durationMs / 1000)} s : ${r.imageId.slice(0, 19)}`, 'info', b.service)
    }
    finally {
      await runner.cleanup(rctx, { path: contextDir }).catch(() => {})
    }
    })
  if (builds.length) await ctx.log('build', `Construction des images terminée en ${formatDuration(Math.round((Date.now() - t0) / 1000))}`)
  // Images de la release : celles des registres (analyse) et celles construites.
  await db().update(schema.releases).set({ images: { ...analysis.images, ...Object.fromEntries(Object.entries(images).map(([s, i]) => [s, i.tag])) }, metadata: { ...(release.metadata as object), imageIds: Object.fromEntries(Object.entries(images).map(([s, i]) => [s, i.id])) } }).where(eq(schema.releases.id, release.id))
  return images
}

/** Analyse Trivy reprise pour une image des registres déjà analysée récemment (même empreinte). */
const REGISTRY_SCAN_REUSE_MS = 24 * 3600_000
/** Sans blocage, l'analyse suit le déploiement : une analyse de moins de 7 jours de la même image est reprise (la planifiée la renouvelle). */
const BACKGROUND_SCAN_REUSE_MS = 7 * 24 * 3600_000

/** Services dont les images, et le code source, sont analysés pour ce déploiement, selon les réglages. */
function deployScanServices(settings: Awaited<ReturnType<typeof trivySettings>>, analysis: AnalysisResult, built: Record<string, unknown>): string[] {
  const builtServices = new Set([...Object.keys(built), ...analysis.builds.map(b => b.service)])
  const services = new Set<string>()
  if (settings.buildScan) for (const s of Object.keys(built)) services.add(s)
  if (settings.registryScan) for (const [service, image] of Object.entries(analysis.images)) if (!builtServices.has(service) && image && !image.includes('${')) services.add(service)
  return [...services]
}

/**
 * Images analysées par Trivy avant le déploiement (réglages de la page Vulnérabilités) :
 * - construites par la console (au build) ;
 * - des registres : récupérées sur l'hôte (à nouveau pour un redéploiement ou une mise à niveau),
 *   analyse de moins de 24 h reprise pour une même empreinte.
 * Résumé dans le journal, résultat enregistré ; déploiement bloqué au-delà du seuil réglé.
 * Une image non récupérable ou une analyse impossible est signalée sans bloquer.
 */
async function scanBeforeDeploy(ctx: PipelineContext, job: Job, analysis: AnalysisResult, built: Record<string, { tag: string, id: string }>, sourceDir: string) {
  const settings = await trivySettings()
  const builtServices = new Set([...Object.keys(built), ...analysis.builds.map(b => b.service)])
  const registry = new Map<string, string[]>()
  if (settings.registryScan) {
    for (const [service, image] of Object.entries(analysis.images)) {
      if (builtServices.has(service) || !image || image.includes('${')) continue
      registry.set(image, [...(registry.get(image) ?? []), service])
    }
  }
  const builtEntries = settings.buildScan ? Object.entries(built) : []
  if (!builtEntries.length && !registry.size && !settings.sourceScan) return
  const conn = await connectionFor(job.serverRow)
  const ca = await extraCa()
  const label = `${job.project.name} (${job.env.name})`
  const target = (services: string[]) => [{ targetId: job.target.id, projectId: job.project.id, label, services }]
  const blocking: { services: string[], findings: Finding[] }[] = []
  const report = async (services: string[], r: { status: string, error: string | null, os: string | null, counts: SeverityCounts, fixable: number, findings: Finding[] }, reused: string | null, blocks = true) => {
    const who = services.join(', ')
    if (r.status === 'error') {
      await ctx.log('build', `Analyse Trivy impossible : ${r.error}`, 'warn', who)
      return
    }
    const c = r.counts
    const total = c.CRITICAL + c.HIGH + c.MEDIUM + c.LOW + c.UNKNOWN
    await ctx.log('build', `Trivy${r.os ? ` (${r.os})` : ''}${reused ? ` — analyse du ${reused} reprise` : ''} : ${total ? `${c.CRITICAL} critique(s), ${c.HIGH} haute(s), ${c.MEDIUM} moyenne(s), ${c.LOW} basse(s), dont ${r.fixable} corrigeable(s)` : 'aucune vulnérabilité relevée'}`, c.CRITICAL || c.HIGH ? 'warn' : 'info', who)
    for (const f of r.findings.filter(x => x.severity === 'CRITICAL' || x.severity === 'HIGH').slice(0, 10)) {
      await ctx.log('build', `${f.severity === 'CRITICAL' ? 'Critique' : 'Haute'} ${f.id} · ${f.pkg} ${f.installed}${f.fixed ? ` → ${f.fixed}` : ' (sans correctif)'}`, 'warn', who)
    }
    const b = blocks ? blockingFindings(r.findings, settings) : []
    if (b.length) blocking.push({ services, findings: b })
  }

  // Analyses indépendantes : la première seule (elle met la base de vulnérabilités à jour sur l'hôte), les suivantes 2 par 2.
  const tasks: (() => Promise<void>)[] = []
  const t0 = Date.now()

  // Dépendances déclarées dans le code source de la release (package-lock.json, requirements.txt…).
  if (settings.sourceScan) tasks.push(async () => {
    const r = await scanSource(conn, job.endpoint, { targetId: job.target.id, releaseId: job.release!.id, sourceDir }, settings, ca, { trigger: 'deploy', deploymentId: ctx.deploymentId })
    const manifests = r.manifests
    await ctx.log('build', r.status === 'ok'
      ? (manifests.length ? `Analyse Trivy des dépendances du code source : ${manifests.length} fichier(s) de dépendances (${manifests.slice(0, 5).join(', ')}${manifests.length > 5 ? '…' : ''})` : 'Analyse Trivy du code source : aucun fichier de dépendances reconnu')
      : 'Analyse Trivy des dépendances du code source')
    if (r.status !== 'ok' || manifests.length) await report(['code source'], r, null, settings.sourceBlock)
  })

  if (builtEntries.length) {
    await ctx.log('build', `Analyse Trivy de ${builtEntries.length} image(s) construite(s) (${settings.severities.join(', ')})`)
    for (const [service, img] of builtEntries) {
      tasks.push(async () => report([service], await scanImage(conn, job.endpoint, { image: img.tag, imageId: img.id, targets: target([service]) }, settings, ca, { trigger: 'deploy', deploymentId: ctx.deploymentId }), null))
    }
  }
  if (registry.size) {
    // Redéploiement ou mise à niveau : les tags sont récupérés à nouveau, comme par le déploiement.
    const force = (job.d.action === 'redeploy' && !job.d.options?.noPull) || !!job.d.options?.upgrade
    await ctx.log('build', `Analyse Trivy de ${registry.size} image(s) des registres${force ? ' (récupérées à nouveau)' : ''}`)
    for (const [image, services] of registry) tasks.push(async () => {
      let id: string
      try {
        id = (await portainer().pullImage(conn, job.endpoint.portainerEndpointId, image, { force })).id
      }
      catch (err) {
        await ctx.log('build', `${image} non récupérée avant le déploiement (${msg(err)}) : analysée à la prochaine analyse planifiée`, 'warn', services.join(', '))
        return
      }
      // Analyse reprise : rattachée à ce déploiement (lien depuis la page Vulnérabilités).
      const recent = await reuseRecentScan(job.endpoint.id, id, target(services), { deploymentId: ctx.deploymentId, reuseMs: REGISTRY_SCAN_REUSE_MS })
      if (recent) {
        await report(services, recent, recent.scannedAt.toISOString().slice(0, 16).replace('T', ' '))
        return
      }
      await report(services, await scanImage(conn, job.endpoint, { image, imageId: id, targets: target(services) }, settings, ca, { trigger: 'deploy', deploymentId: ctx.deploymentId }), null)
    })
  }
  if (tasks.length) {
    await tasks[0]!()
    await mapLimit(tasks.slice(1), 2, t => t())
    await ctx.log('build', `Analyses Trivy terminées en ${formatDuration(Math.round((Date.now() - t0) / 1000))}`)
  }
  await ctx.log('build', 'Résultats enregistrés : page Vulnérabilités et onglet Vulnérabilités du projet (pas besoin de relancer une analyse)')
  if (blocking.length) {
    const n = blocking.reduce((a, x) => a + x.findings.length, 0)
    throw new Error(`Trivy : ${n} vulnérabilité(s) ${settings.buildBlock === 'CRITICAL' ? 'critique(s)' : 'critique(s) ou haute(s)'}${settings.buildBlockFixableOnly ? ' corrigeable(s)' : ''} dans ${blocking.flatMap(b => b.services).join(', ')} : déploiement bloqué (réglage de la page Vulnérabilités). Mettre à jour l'image (version corrigée) ou les dépendances, puis redéployer.`)
  }
}

async function stackEnv(job: Job) {
  const vars = await targetVariables(job.target)
  const [fresh] = await db().select().from(schema.projectTargets).where(eq(schema.projectTargets.id, job.target.id))
  return [
    ...Object.entries(vars).filter(([, v]) => v.secret).map(([name, v]) => ({ name, value: v.value })),
    ...await watchtowerStackEnv(fresh!),
  ]
}

/**
 * Après une mise en service (déploiement ou rollback) : images de référence pour
 * détecter les changements hors plateforme, configuration Watchtower appliquée.
 */
async function afterActivation(ctx: PipelineContext, job: Job, conn: PortainerConnection, stackName: string) {
  const containers = await portainer().stackContainers(conn, job.endpoint.portainerEndpointId, stackName)
  await recordBaseline(job.target.id, containers)
  const [fresh] = await db().select({ watchtower: schema.projectTargets.watchtower }).from(schema.projectTargets).where(eq(schema.projectTargets.id, job.target.id))
  const cfg = watchtowerConfig.parse(fresh?.watchtower ?? {})
  const deployed = cfg.enabled && !!cfg.profileId
  // Santé de référence : une dégradation constatée ensuite sera notifiée (celle du déploiement l'est déjà).
  const failing = containers.filter(c => c.service && (!c.running || c.health === 'unhealthy')).map(c => ({ service: c.service!, state: c.running ? 'unhealthy' : c.status }))
  const healthState = { checkedAt: new Date().toISOString(), status: failing.length ? 'degraded' as const : 'healthy' as const, failing }
  await db().update(schema.projectTargets).set({ watchtowerApplied: deployed ? cfg : null, watchtowerPausedAt: null, healthState }).where(eq(schema.projectTargets.id, job.target.id))
  // Watchtower du profil du serveur : déployé ou mis à jour au besoin (rythme, exclusions), partagé par ses projets.
  if (deployed) {
    try {
      const changed = await ensureProfileApplied(cfg.profileId!)
      const profile = await getProfileOr404(cfg.profileId!)
      await db().update(schema.projectTargets).set({ watchtowerImageApplied: (profile.applied as { image?: string } | null)?.image ?? null }).where(eq(schema.projectTargets.id, job.target.id))
      await ctx.log('system', `Watchtower du profil « ${profile.name} »${changed ? ' (déployé ou mis à jour)' : ''} : ${Object.entries(cfg.services).filter(([, p]) => p !== 'off').map(([svc, p]) => `${svc} → ${p === 'update' && cfg.mode !== 'manual' ? 'mise à jour' : 'signalement'}`).join(', ') || 'selon les labels'}`)
    }
    catch (err) {
      await ctx.log('system', `Watchtower du profil non appliqué : ${msg(err)}`, 'warn')
    }
  }
}

/** Stack dont tous les conteneurs portent les labels de la plateforme pour ce projet et cet environnement. */
async function ownedByTarget(conn: PortainerConnection, job: Job, stackName: string): Promise<boolean> {
  const containers = (await portainer().listContainers(conn, job.endpoint.portainerEndpointId)).filter(c => c.labels['com.docker.compose.project'] === stackName)
  return containers.length > 0 && containers.every(c => c.labels['platform.managed'] === 'true' && c.labels['platform.project'] === job.project.slug && c.labels['platform.environment'] === job.env.key)
}

/** Crée ou met à jour la stack sur l'hôte ; refuse de prendre le contrôle d'une stack non gérée. */
async function deployStack(ctx: PipelineContext, job: Job, conn: PortainerConnection, stackName: string, compose: string, opts: { record?: boolean, pull?: boolean } = {}): Promise<number> {
  // Migration : la stack de la cible reste celle de l'origine tant que la bascule n'est pas faite.
  const record = opts.record ?? true
  const p = portainer()
  // Variables secrètes : hôtes des services remplacés par leurs alias uniques (réseau partagé).
  const aliased = rewriteStackEnv(await stackEnv(job), aliasPlanFromYaml(compose.replace(/^#.*\n/, ''), stackName))
  const envVars = aliased.env
  if (aliased.rewritten.length) await ctx.log('portainer', `Alias uniques des services appliqués aux variables secrètes : ${aliased.rewritten.join(', ')}`)
  await detachExcluded(ctx, job, conn, stackName)
  // Redéploiement : les images des registres sont retirées (mise à jour manuelle).
  const input = { endpointId: job.endpoint.portainerEndpointId, name: stackName, composeContent: compose, env: envVars, pullImage: opts.pull ?? (job.d.action === 'redeploy' && !job.d.options?.noPull), onWarning: (m: string) => ctx.log('portainer', m, 'warn') }
  let stackId = job.target.portainerStackId
  if (stackId && !(await p.findStack(conn, stackName, job.endpoint.portainerEndpointId))) {
    await ctx.log('portainer', `Stack ${stackName} absente de l'hôte : elle sera recréée`, 'warn')
    stackId = null
  }
  if (stackId) {
    await ctx.log('portainer', `Mise à jour de la stack ${stackName} (#${stackId})`)
    await p.updateStack(conn, stackId, input)
  }
  else {
    const existing = await p.findStack(conn, stackName, job.endpoint.portainerEndpointId)
    if (existing && !(await ownedByTarget(conn, job, stackName))) throw new Error(`Une stack « ${stackName} » existe déjà sur l'hôte et n'est pas gérée par la plateforme`)
    if (existing) {
      // Restes d'un premier déploiement interrompu de cette cible : repris et mis à jour.
      await ctx.log('portainer', `Stack ${stackName} issue d'un déploiement précédent de ce projet (non enregistré) : reprise et mise à jour`, 'warn')
      stackId = (await p.updateStack(conn, existing.id, input)).id
    }
    else {
      await ctx.log('portainer', `Création de la stack ${stackName}`)
      try {
        stackId = (await p.createStack(conn, input)).id
      }
      catch (err) {
        // Échec en cours de création (ex. dépendance jamais saine) : conteneurs déjà créés, la stack reste celle de la cible.
        const created = await p.findStack(conn, stackName, job.endpoint.portainerEndpointId).catch(() => null)
        if (created && record) await db().update(schema.projectTargets).set({ portainerStackId: created.id, stackName }).where(eq(schema.projectTargets.id, job.target.id))
        throw err
      }
    }
  }
  if (record) await db().update(schema.projectTargets).set({ portainerStackId: stackId, stackName }).where(eq(schema.projectTargets.id, job.target.id))
  job.target.portainerStackId = stackId
  await ctx.log('portainer', `Stack ${stackName} déployée (#${stackId}) avec ${envVars.length} variable(s) secrète(s)`)
  return stackId
}

/**
 * Services non gérés : leurs conteneurs encore dans la stack en sont détachés avant le déploiement
 * (sinon « --remove-orphans » les supprimerait) et continuent de tourner hors de la stack.
 */
async function detachExcluded(ctx: PipelineContext, job: Job, conn: PortainerConnection, stackName: string) {
  const [fresh] = await db().select({ o: schema.projectTargets.composeOverrides }).from(schema.projectTargets).where(eq(schema.projectTargets.id, job.target.id))
  const excluded = Object.keys(fresh?.o.excludedServices ?? {})
  if (!excluded.length) return
  const p = portainer()
  const containers = (await p.listContainers(conn, job.endpoint.portainerEndpointId)).filter(c => c.labels['com.docker.compose.project'] === stackName && excluded.includes(c.labels['com.docker.compose.service'] ?? ''))
  for (const c of containers) {
    const service = c.labels['com.docker.compose.service']!
    const r = await p.detachContainer(conn, job.endpoint.portainerEndpointId, c.id)
    await ctx.log('portainer', `Service non géré ${service} : conteneur ${r.name} détaché de la stack ${stackName} (recréé à l'identique, toujours en service ; ni arrêté ni mis à jour par la console)`, 'info', service)
  }
}

const HELPER_IMAGE = process.env.HOST_HELPER_IMAGE || 'busybox:1.37'

/** Conteneur éphémère sans réseau (image d'appoint), pour copier ou restaurer un volume. */
async function helperRun(conn: PortainerConnection, job: Job, ctx: PipelineContext, binds: string[], script: string) {
  const r = await portainer().runOneShot(conn, job.endpoint.portainerEndpointId, {
    image: HELPER_IMAGE,
    entrypoint: ['sh', '-c'],
    cmd: [script],
    binds,
    files: [],
    outputs: [],
    outputLimits: { maxBytes: 0, maxFiles: 0 },
    labels: { 'platform.managed': 'true', 'platform.role': 'volume-backup', 'platform.deployment': ctx.deploymentId },
    timeoutMs: 4 * 3600_000,
    memoryMb: 1024,
  })
  const lines = r.logs.map(l => l.trim()).filter(Boolean)
  if (r.exitCode !== 0) throw new Error(lines.at(-1) ?? `code ${r.exitCode}`)
  return lines
}

/**
 * Sauvegarde à froid des volumes des services à données avant une mise à niveau : stack arrêtée
 * (fichiers cohérents), une archive par volume dans shared/backups/<déploiement> sur l'hôte.
 */
async function backupVolumes(ctx: PipelineContext, job: Job, conn: PortainerConnection, runner: TargetRunner, sharedDir: string) {
  const b = job.d.options!.upgrade!.backup!
  const dir = `${sharedDir}/backups/${ctx.deploymentId.slice(0, 8)}`
  await runner.ensureDir({ requestId: ctx.deploymentId, actor: 'worker' }, { path: dir, mode: '0700', claim: true })
  if (job.target.portainerStackId) {
    await portainer().stopStack(conn, job.target.portainerStackId, job.endpoint.portainerEndpointId)
    await ctx.log('system', `Stack arrêtée pour sauvegarder les données de ${b.services.map(s => s.service).join(', ')}`)
  }
  for (const s of b.services) {
    for (const [i, m] of s.mounts.entries()) {
      const file = `${s.service}-${i}.tgz`
      const out = await helperRun(conn, job, ctx, [`${m.source}:/src:ro`, `${dir}:/backup`], `set -eu\ncd /src\ntar -czf /backup/${file}.part .\nmv /backup/${file}.part /backup/${file}\necho "$(wc -c < /backup/${file}) octets"`)
      await ctx.log('service', `Sauvegarde de ${m.destination} (${m.source}) : ${dir}/${file}, ${out.at(-1) ?? ''}`, 'info', s.service)
    }
  }
  b.dir = dir
  await db().update(schema.deployments).set({ options: job.d.options! }).where(eq(schema.deployments.id, ctx.deploymentId))
}

/** Retour : volumes remis dans l'état de la sauvegarde (stack arrêtée). */
async function restoreVolumes(ctx: PipelineContext, job: Job, conn: PortainerConnection) {
  const b = job.d.options!.upgrade!.backup!
  if (job.target.portainerStackId) await portainer().stopStack(conn, job.target.portainerStackId, job.endpoint.portainerEndpointId)
  for (const s of b.services) {
    for (const [i, m] of s.mounts.entries()) {
      const file = `${s.service}-${i}.tgz`
      await helperRun(conn, job, ctx, [`${m.source}:/dst`, `${b.dir}:/backup:ro`], `set -eu\ntest -s /backup/${file}\nfind /dst -mindepth 1 -maxdepth 1 -exec rm -rf {} +\ntar -xzpf /backup/${file} -C /dst`)
      await ctx.log('service', `Données de ${m.destination} restaurées depuis la sauvegarde`, 'warn', s.service)
    }
  }
}

/**
 * Migration de PostgreSQL vers une nouvelle version majeure (voir lib/pg-migration) : stack
 * arrêtée, sauvegarde sur l'image actuelle, restauration sur la nouvelle dans un sous-dossier du
 * même volume. Les données d'origine ne sont jamais modifiées.
 */
async function migratePostgres(ctx: PipelineContext, job: Job, conn: PortainerConnection, runner: TargetRunner, sharedDir: string) {
  const m = job.d.options!.pgMigration!
  const p = portainer()
  const epId = job.endpoint.portainerEndpointId
  const log = (message: string, level: LogLevel = 'info') => ctx.log('service', message, level, m.service)
  const backupDir = `${sharedDir}/pg-migration/${ctx.deploymentId.slice(0, 8)}`
  await runner.ensureDir({ requestId: ctx.deploymentId, actor: 'worker' }, { path: backupDir, mode: '0700', claim: true })
  await log(`Migration de ${m.service} vers PostgreSQL ${m.targetMajor} : ${normalizeImage(m.fromImage)} → ${normalizeImage(m.toImage)} ; sauvegarde dans ${backupDir} ; nouvelles données dans ${m.newPgdata} (anciennes conservées dans ${m.oldPgdata})`)
  if (job.target.portainerStackId) {
    await p.stopStack(conn, job.target.portainerStackId, epId)
    await log('Stack arrêtée : plus aucune écriture pendant la migration')
  }
  const layout = pgLayout(m.mountPath, m.oldPgdata, m.user, m.targetMajor)
  const preload = await pgPreloads(job, conn, m.service, m.fromImage, m.toImage).catch(async (err) => {
    await log(`Bibliothèques préchargées du service non lues (${msg(err)}) : serveur temporaire sans préchargement`, 'warn')
    return { before: '', after: '', beforeConfig: null, afterConfig: null }
  })
  const step = async (label: string, image: string, script: string) => {
    const r = await p.runOneShot(conn, epId, {
      image,
      entrypoint: ['sh', '-c'],
      cmd: [script],
      binds: [`${m.mountSource}:${m.mountPath}`, `${backupDir}:/backup`],
      files: [],
      outputs: [],
      outputLimits: { maxBytes: 0, maxFiles: 0 },
      labels: { 'platform.managed': 'true', 'platform.role': 'pg-migration', 'platform.deployment': ctx.deploymentId },
      timeoutMs: 4 * 3600_000,
      memoryMb: 2048,
    })
    const lines = r.logs.map(l => l.trimEnd()).filter(Boolean)
    for (const l of lines.filter(l => !/^(waiting for server|server (started|stopped)| done$)/.test(l.trim())).slice(-20)) await log(`${label} : ${l}`, r.exitCode ? 'warn' : 'info')
    if (r.exitCode !== 0) throw new Error(`${label} en échec (code ${r.exitCode}) : ${lines.at(-1) ?? 'aucune sortie'}`)
  }
  await step('Sauvegarde', m.fromImage, dumpScript(layout, preload.before, preload.beforeConfig))
  await step('Restauration', m.toImage, restoreScript(layout, preload.after, preload.afterConfig))
  await log(`Données restaurées dans PostgreSQL ${m.targetMajor} : redéploiement de la stack`)
  const [cur] = await db().select({ o: schema.projectTargets.composeOverrides }).from(schema.projectTargets).where(eq(schema.projectTargets.id, job.target.id))
  const entry = cur?.o.pgData?.[m.service]
  if (entry) await db().update(schema.projectTargets).set({ composeOverrides: { ...cur!.o, pgData: { ...cur!.o.pgData, [m.service]: { ...entry, backupDir } } } }).where(eq(schema.projectTargets.id, job.target.id))
}

/** Image impossible à tirer : sources équivalentes disponibles indiquées dans le journal. */
async function suggestImageSources(ctx: PipelineContext, err: unknown) {
  const m = msg(err).match(/(?:unable to get image|pull access denied for|manifest for|Error response from daemon: [^']*?) '?([a-z0-9][\w./-]*(?::[\w.-]+)?)'?/i)
  if (!m || !/unable to get image|pull access denied|manifest (unknown|for .* not found)|not found/i.test(msg(err))) return
  const alternatives = await availableAlternatives(m[1]!).catch(() => [] as string[])
  if (alternatives.length) await ctx.log('portainer', `Image ${m[1]} non récupérée : sources équivalentes disponibles (${alternatives.join(', ')}). Les proposer en relançant l'analyse (Déployer → Analyser), qui permet de choisir une autre source`, 'warn')
}

/**
 * Bibliothèques préchargées (shared_preload_libraries…) du service PostgreSQL : celles de son
 * conteneur pour la sauvegarde ; pour la restauration, celles de la commande du Compose si elle en
 * fixe, sinon celles de la commande par défaut de la nouvelle image (tirée au besoin).
 */
async function pgPreloads(job: Job, conn: PortainerConnection, service: string, fromImage: string, toImage: string): Promise<{ before: string, after: string, beforeConfig: string | null, afterConfig: string | null }> {
  const p = portainer()
  const ep = job.endpoint.portainerEndpointId
  const stack = job.target.stackName ?? ''
  const c = (await p.listContainers(conn, ep)).find(x => x.labels['com.docker.compose.project'] === stack && x.labels['com.docker.compose.service'] === service)
  const cfg = c ? await p.inspectConfig(conn, ep, c.id) : null
  const beforeCmd = cfg?.cmd ?? (await p.imageConfig(conn, ep, fromImage))?.cmd ?? []
  const before = preloadOptions(beforeCmd)
  const beforeConfig = configFileOf(beforeCmd)
  // Commande imposée par le Compose : la même sur la nouvelle image.
  const doc = YAML.parse(job.release?.composeFinal ?? '') as { services?: Record<string, { command?: unknown }> } | null
  const command = doc?.services?.[service]?.command
  if (command !== undefined && command !== null) {
    const cmd = Array.isArray(command) ? command.map(String) : [String(command)]
    return { before, beforeConfig, after: preloadOptions(cmd), afterConfig: configFileOf(cmd) }
  }
  let defaults = await p.imageConfig(conn, ep, toImage)
  if (!defaults) {
    // Nouvelle image absente de l'hôte : tirée par un conteneur ponctuel sans effet.
    await p.runOneShot(conn, ep, { image: toImage, entrypoint: ['true'], cmd: [], binds: [], files: [], outputs: [], outputLimits: { maxBytes: 0, maxFiles: 0 }, labels: { 'platform.managed': 'true', 'platform.role': 'pg-migration' }, timeoutMs: 30 * 60_000 })
    defaults = await p.imageConfig(conn, ep, toImage)
  }
  return { before, beforeConfig, after: preloadOptions(defaults?.cmd ?? []), afterConfig: configFileOf(defaults?.cmd ?? []) }
}

/**
 * Reverse proxy nginx « classique » : configuration des expositions de la cible écrite dans conf.d
 * du conteneur nginx (fichier de la stack, vide si plus rien n'est exposé), puis rechargement (HUP).
 * nginx garde l'ancienne configuration si la nouvelle est invalide : l'erreur est relevée dans ses
 * logs, et le fichier précédent est remis.
 */
/** Configuration nginx applicable à la cible (propre à son environnement d'abord). */
async function nginxConfigOf(job: Job) {
  const rows = await db().select().from(schema.traefikConfigs).where(eq(schema.traefikConfigs.endpointId, job.endpoint.id))
  return proxyConfigFor(rows, job.env.id)
}

/**
 * nginx-proxy : certificats des domaines de la cible déposés dans /etc/nginx/certs avant le
 * démarrage des conteneurs (nginx-proxy ne les cherche qu'à la régénération de sa configuration).
 */
async function pushNginxProxyCertificates(ctx: PipelineContext, job: Job, conn: PortainerConnection) {
  const cfg = await nginxConfigOf(job)
  if (cfg?.provider !== 'nginx-proxy' || !cfg.nginxContainer || !job.target.exposures.length) return
  const h = await nginxHandle(conn, job.endpoint, cfg.nginxContainer)
  if (!h) return
  const hosts = job.target.exposures.map(e => e.host)
  // Let's Encrypt par DNS-01 (nginx-proxy ne sert pas le défi HTTP-01 de la console).
  await issueMissingAcme(h, cfg, hosts, (m, level) => ctx.log('system', m, level ?? 'info'))
  const tls = await pushNginxCertificates(h, certsDirOf(cfg), hosts, { withDefault: true })
  if (Object.keys(tls).length) await ctx.log('system', `nginx-proxy : certificat(s) déposé(s) pour ${Object.keys(tls).join(', ')} (${NGINX_PROXY_CERTS_DIR})`)
}

async function applyNginxSites(ctx: PipelineContext, job: Job, conn: PortainerConnection, stackName: string, opts: { remove?: boolean } = {}) {
  const cfg = await nginxConfigOf(job)
  if (cfg?.provider !== 'nginx' || !cfg.nginxContainer) return
  const p = portainer()
  const ep = job.endpoint.portainerEndpointId
  const h = await nginxHandle(conn, job.endpoint, cfg.nginxContainer)
  if (!h) {
    await ctx.log('system', `nginx : conteneur ${cfg.nginxContainer} arrêté ou introuvable sur ${job.server.name} : configuration des sites non écrite (à refaire par un redéploiement)`, 'warn')
    return
  }
  const [fresh] = await db().select({ exposures: schema.projectTargets.exposures }).from(schema.projectTargets).where(eq(schema.projectTargets.id, job.target.id))
  const exposures = opts.remove ? [] : fresh?.exposures ?? []
  const hosts = exposures.map(e => e.host)
  const file = nginxSiteFile(stackName)
  const path = `${trimTrailingSlashes(cfg.nginxConfDir)}/${file}`
  const formatPath = `${trimTrailingSlashes(cfg.nginxConfDir)}/${NGINX_LOG_FORMAT_FILE}`
  const readOne = async (pth: string) => (await p.readContainerFiles(conn, ep, h.containerId, pth, { maxBytes: 1024 * 1024, maxFiles: 1 }).catch(() => null))?.[0]?.content ?? null
  const previous = await readOne(path)
  // Format du journal d'accès de la console : défini une fois, avant les sites qui l'utilisent.
  const withFormat = cfg.nginxAccessLog === 'json' && !opts.remove
  const previousFormat = withFormat ? await readOne(formatPath) : null
  const put = async (files: { name: string, text: string }[]) => {
    const tar = pack()
    for (const f of files) tar.entry({ name: f.name, mode: 0o644 }, f.text)
    tar.finalize()
    await p.putArchive(conn, ep, h.containerId, cfg.nginxConfDir, tar as unknown as import('node:stream').Readable, 60_000)
  }
  // Écrit, recharge et vérifie : configuration refusée par nginx → version précédente remise.
  const apply = async (tls: Record<string, NginxTlsFiles>): Promise<boolean> => {
    const content = nginxSiteConfig(stackName, `${job.project.slug} (${job.env.key})`, exposures, {
      redirectToHttps: cfg.redirectToHttps,
      sslCertificate: cfg.nginxSslCertificate,
      sslCertificateKey: cfg.nginxSslCertificateKey,
      tls,
      acmeWebroot: cfg.nginxAcmeEmail ? NGINX_ACME_WEBROOT : null,
      accessLog: cfg.nginxAccessLog,
    })
    await put([...(withFormat ? [{ name: NGINX_LOG_FORMAT_FILE, text: nginxLogFormatConfig() }] : []), { name: file, text: content }])
    const before = new Set(await p.containerLogs(conn, ep, h.containerId, 50).catch(() => [] as string[]))
    await p.signalContainer(conn, ep, h.containerId, 'HUP')
    await new Promise(r => setTimeout(r, 1500))
    const fresh2 = (await p.containerLogs(conn, ep, h.containerId, 80).catch(() => [] as string[])).filter(l => !before.has(l))
    const failure = fresh2.find(l => /\[(emerg|alert|crit)\]/.test(l))
    if (!failure) return true
    await put([
      ...(withFormat ? [{ name: NGINX_LOG_FORMAT_FILE, text: previousFormat ?? `# ${NGINX_LOG_FORMAT_FILE} : configuration refusée par nginx, retirée\n` }] : []),
      { name: file, text: previous ?? `# ${file} : configuration refusée par nginx, retirée\n` },
    ])
    await p.signalContainer(conn, ep, h.containerId, 'HUP').catch(() => {})
    await ctx.log('system', `nginx a refusé la configuration des sites (${failure.replace(/^.*\[(emerg|alert|crit)\] \d+#\d+: /, '')}) : configuration précédente remise, sites inchangés`, 'error')
    return false
  }
  const certsDir = certsDirOf(cfg)
  const pushed = await pushNginxCertificates(h, certsDir, hosts)
  if (!await apply(pushed)) return
  // Let's Encrypt : défi servi par la configuration écrite ci-dessus, puis HTTPS pour les domaines obtenus.
  const issued = await issueMissingAcme(h, cfg, hosts, (m, level) => ctx.log('system', m, level ?? 'info'))
  let tls = pushed
  if (issued.length) {
    tls = await pushNginxCertificates(h, certsDir, hosts)
    if (!await apply(tls)) return
  }
  const count = new Set(hosts).size
  const https = Object.keys(tls).length
  await ctx.log('system', opts.remove
    ? `nginx : sites de ${stackName} retirés (${file} vidé) et nginx rechargé`
    : `nginx : ${count} site(s) écrits dans ${path}${https ? ` (${https} en HTTPS, certificats dans ${certsDir})` : ''} et nginx rechargé (${cfg.nginxContainer})`)
}

async function checkHealth(ctx: PipelineContext, job: Job, conn: PortainerConnection, stackName: string, services: string[]) {
  const r = await waitForStack({
    adapter: portainer(),
    conn,
    endpointId: job.endpoint.portainerEndpointId,
    stackName,
    services,
    timeoutMs: job.target.healthTimeoutSec * 1000,
    log: (m, level, service) => ctx.log('healthcheck', m, level ?? 'info', service),
  })
  for (const s of r.services.filter(x => x.logTail?.length)) {
    await ctx.log('service', `Dernières lignes de ${s.service} :`, 'warn', s.service)
    for (const line of s.logTail!) await ctx.log('service', line, 'warn', s.service)
  }
  return r
}

/** Rétention : répertoires et images des releases au-delà de releasesToKeep. */
async function pruneReleases(ctx: PipelineContext, job: Job, runner: TargetRunner) {
  if (!job.paths || !job.release) return
  const old = await db().select({ id: schema.releases.id, slug: schema.releases.slug, images: schema.releases.images })
    .from(schema.releases)
    .where(and(eq(schema.releases.targetId, job.target.id), isNull(schema.releases.purgedAt), isNotNull(schema.releases.remotePath)))
    .orderBy(desc(schema.releases.number))
    .offset(job.paths.releasesToKeep)
  const removable = old.filter(r => r.slug && r.id !== job.release!.id && r.id !== job.target.currentReleaseId)
  if (!removable.length) return
  const rctx = { requestId: ctx.deploymentId, actor: 'worker' }
  const bytes = await removeReleaseDirs(runner, rctx, projectLayout(job.paths, job.project.slug, job.target.projectPath), removable.map(r => r.slug!))
  const tags = removable.flatMap(r => Object.values(r.images)).filter(t => t.startsWith('platform/'))
  let imagesNote = ''
  if (tags.length && (await runner.health()).actions.includes('removeImages')) {
    const ri = await runner.removeImages(rctx, { tags })
    imagesNote = `, ${ri.removed.length} image(s) supprimée(s)`
    for (const f of ri.failed) await ctx.log('system', `Image ${f.tag} conservée : ${f.reason}`, 'warn')
  }
  await db().update(schema.releases).set({ purgedAt: new Date() }).where(inArray(schema.releases.id, removable.map(r => r.id)))
  await ctx.log('system', `Rétention : ${removable.length} ancienne(s) release(s) supprimée(s) (${formatBytes(bytes)} libérés${imagesNote})`)
}

async function runDeploy(ctx: PipelineContext, job: Job) {
  const runner = await runnerFor(job.endpoint.id)
  await ctx.transition('PREPARING_FILES')
  const prep = await prepareFiles(ctx, job, runner)

  const analysis = await revalidate(ctx, job, await releaseSourceFiles(job.release!))

  await ctx.transition('BUILDING')
  const built = await buildImages(ctx, job, runner, prep, analysis)
  // Sans blocage, les analyses ne retardent pas le déploiement : lancées en arrière-plan une fois la stack en service.
  const trivy = await trivySettings()
  const scanLater = trivy.buildBlock === 'off'
  const laterServices = scanLater ? deployScanServices(trivy, analysis, built) : []
  if (scanLater) {
    if (laterServices.length || trivy.sourceScan) await ctx.log('build', `Analyses Trivy après le déploiement (blocage désactivé) : ${laterServices.length} image(s)${trivy.sourceScan ? ' et le code source' : ''}, résultats dans la page Vulnérabilités`)
  }
  else {
    await scanBeforeDeploy(ctx, job, analysis, built, prep.sourceDir)
    // Demandes de correction : résolues si ces analyses ne relèvent plus leurs vulnérabilités.
    await markResolvedRequests().catch(err => ctx.log('system', `Suivi des demandes de correction : ${msg(err)}`, 'warn'))
  }

  await ctx.transition('DEPLOYING')
  const rctx = { requestId: ctx.deploymentId, actor: 'worker' }
  const composeFile = prep.layout.release(job.release!.slug!).composeFile
  await runner.writeFile(rctx, { path: composeFile, content: analysis.finalYaml!, mode: '0640' })
  await ctx.log('portainer', `Compose final écrit : ${composeFile}`)
  const conn = await connectionFor(job.serverRow)
  const previousReleaseId = job.target.currentReleaseId
  if (job.d.options?.upgrade?.backup?.services.length) {
    try {
      await backupVolumes(ctx, job, conn, runner, prep.layout.sharedDir)
    }
    catch (err) {
      // Aucune image n'a changé : la stack repart telle quelle.
      await rollbackUpgrade(ctx, job, analysis.stackName, `Sauvegarde des données en échec : ${msg(err)}`)
      return
    }
  }
  if (job.d.options?.pgMigration) {
    try {
      await migratePostgres(ctx, job, conn, runner, prep.layout.sharedDir)
    }
    catch (err) {
      // Anciennes données intactes : la stack repart sur l'image précédente.
      await rollbackUpgrade(ctx, job, analysis.stackName, `Migration de PostgreSQL en échec : ${msg(err)}`)
      return
    }
  }
  await pushNginxProxyCertificates(ctx, job, conn).catch(err => ctx.log('system', `nginx-proxy : certificats non déposés : ${msg(err)}`, 'warn'))
  await deployStack(ctx, job, conn, analysis.stackName, analysis.finalYaml!).catch(async (err) => {
    await suggestImageSources(ctx, err)
    throw err
  })

  await ctx.transition('HEALTH_CHECKING')
  const health = await checkHealth(ctx, job, conn, analysis.stackName, analysis.services)

  const failing = health.services.filter(s => s.state !== 'healthy' && s.state !== 'running')
  const canRollback = job.target.autoRollback && !!previousReleaseId && previousReleaseId !== job.release!.id

  // Mise à niveau d'images : un service dégradé suffit à revenir aux images précédentes.
  const upgrading = !!job.d.options?.upgrade
  if (health.outcome === 'HEALTHY' || (health.outcome === 'DEGRADED' && !canRollback && !upgrading)) {
    await db().update(schema.releases).set({ activatedAt: new Date() }).where(eq(schema.releases.id, job.release!.id))
    await db().update(schema.projectTargets).set({ currentReleaseId: job.release!.id }).where(eq(schema.projectTargets.id, job.target.id))
    job.target.currentReleaseId = job.release!.id
    await afterActivation(ctx, job, conn, analysis.stackName).catch(err => ctx.log('system', `Référence des images non enregistrée : ${msg(err)}`, 'warn'))
    // Images remplacées : leurs anciennes détections (page Vulnérabilités) n'ont plus lieu d'être.
    await db().select({ images: schema.releases.images }).from(schema.releases).where(eq(schema.releases.id, job.release!.id))
      .then(([r]) => pruneTargetScans(job.endpoint.id, job.target.id, Object.values((r?.images ?? {}) as Record<string, string>)))
      .then(n => (n ? ctx.log('system', `Vulnérabilités : ${n} analyse(s) d'images remplacées retirée(s)`) : undefined))
      .catch(err => ctx.log('system', `Analyses d'images remplacées non retirées : ${msg(err)}`, 'warn'))
    if (scanLater && (laterServices.length || trivy.sourceScan)) {
      await requestTrivyScan({ targetId: job.target.id, trigger: 'déploiement', deploy: { services: laterServices, source: trivy.sourceScan, deploymentId: ctx.deploymentId, reuseMs: BACKGROUND_SCAN_REUSE_MS } })
        .catch(err => ctx.log('system', `Analyse Trivy non lancée : ${msg(err)}`, 'warn'))
    }
    await applyNginxSites(ctx, job, conn, analysis.stackName).catch(err => ctx.log('system', `Configuration nginx non appliquée : ${msg(err)}`, 'error'))
    if (health.outcome === 'DEGRADED') {
      await ctx.transition('DEGRADED', `Services en échec : ${failing.map(s => s.service).join(', ')}${previousReleaseId ? ' (rollback automatique désactivé)' : ' (aucune release précédente vers laquelle revenir)'}`)
      return
    }
    await ctx.transition('HEALTHY')
    // Mise à niveau réussie : nouvelles images reportées dans le Compose du projet.
    if (job.d.options?.upgrade || job.d.options?.pgMigration) {
      await bakeImageOverrides(job.target.id, job.release!.id).then(async (b) => {
        if (b.changed.length) await ctx.log('system', `Compose du projet mis à jour avec les nouvelles images : ${b.changed.join(', ')}`)
        for (const m of b.manual) await ctx.log('system', `[${m.service}] Compose du projet non modifié (${m.reason}) : l'image mise à niveau reste appliquée par la console`, 'warn', m.service)
      }, err => ctx.log('system', `Report des images dans le Compose impossible : ${msg(err)}`, 'warn'))
    }
    // Action en attente : vérifiée (variable renseignée puis déploiement réussi…), levée seulement si elle est faite.
    await resolvePending(job.target.id, 'worker').catch(err => ctx.log('system', `Vérification de l'action en attente impossible : ${msg(err)}`, 'warn'))
    await pruneReleases(ctx, job, runner).catch(err => ctx.log('system', `Rétention impossible : ${msg(err)}`, 'warn'))
    return
  }

  // Une nouvelle release qui casse un service est une release en échec, même si d'autres services tournent.
  const failure = `Healthchecks en échec : ${failing.map(s => `${s.service} (${s.detail})`).join(', ')}`
  await ctx.transition('FAILED', failure)
  // Mise à niveau d'images (même release) : retour aux images précédentes.
  if (job.d.options?.upgrade) {
    await rollbackUpgrade(ctx, job, analysis.stackName, failure)
    return
  }
  if (!canRollback) {
    await ctx.log('system', previousReleaseId ? 'Rollback automatique désactivé pour cette cible' : 'Pas de release précédente : aucun rollback possible', 'warn')
    return
  }

  // Rollback automatique vers la dernière release active.
  const [prev] = await db().select().from(schema.releases).where(eq(schema.releases.id, previousReleaseId))
  if (!prev?.composeFinal) {
    await ctx.log('system', 'Release précédente sans Compose final : rollback impossible', 'error')
    return
  }
  await ctx.transition('ROLLING_BACK')
  try {
    await ctx.log('portainer', `Rollback vers la release #${prev.number} (${prev.slug})`, 'warn')
    await deployStack(ctx, job, conn, analysis.stackName, prev.composeFinal)
    const services = (prev.analysis as { services?: string[] }).services ?? analysis.services
    const rb = await checkHealth(ctx, job, conn, analysis.stackName, services)
    const broken = rb.services.filter(s => s.state !== 'healthy' && s.state !== 'running').map(s => s.service)
    if (broken.length) throw new Error(`la release précédente ne démarre pas pour ${broken.join(', ')}`)
    await db().update(schema.projectTargets).set({ currentReleaseId: prev.id }).where(eq(schema.projectTargets.id, job.target.id))
    await afterActivation(ctx, job, conn, analysis.stackName).catch(err => ctx.log('system', `Référence des images non enregistrée : ${msg(err)}`, 'warn'))
    await ctx.transition('ROLLED_BACK', `${failure} — release #${prev.number} restaurée`)
  }
  catch (err) {
    await ctx.transition('FAILED', `${failure} ; rollback en échec : ${msg(err)}`)
  }
}

// ---------------------------------------------------------------------------
// Cycle de vie
// ---------------------------------------------------------------------------

async function runLifecycle(ctx: PipelineContext, job: Job) {
  const p = portainer()
  const conn = await connectionFor(job.serverRow)
  const stackName = job.target.stackName
  const stackId = job.target.portainerStackId
  const epId = job.endpoint.portainerEndpointId
  const action = job.d.action

  if (action === 'delete') {
    await ctx.transition('DELETING')
    if (stackId && stackName && await p.findStack(conn, stackName, epId)) {
      await p.deleteStack(conn, stackId, epId)
      await ctx.log('portainer', `Stack ${stackName} supprimée`)
      await applyNginxSites(ctx, job, conn, stackName, { remove: true }).catch(err => ctx.log('system', `Sites nginx non retirés : ${msg(err)}`, 'warn'))
    }
    else {
      await ctx.log('portainer', 'Aucune stack à supprimer sur l\'hôte', 'warn')
    }
    if (job.paths) {
      const runner = await runnerFor(job.endpoint.id)
      const releases = await db().select().from(schema.releases).where(and(eq(schema.releases.targetId, job.target.id), isNull(schema.releases.purgedAt), isNotNull(schema.releases.slug)))
      const rctx = { requestId: ctx.deploymentId, actor: 'worker' }
      const bytes = await removeReleaseDirs(runner, rctx, projectLayout(job.paths, job.project.slug, job.target.projectPath), releases.map(r => r.slug!))
      const tags = releases.flatMap(r => Object.values(r.images)).filter(t => t.startsWith('platform/'))
      if (tags.length && (await runner.health()).actions.includes('removeImages')) await runner.removeImages(rctx, { tags })
      if (releases.length) await db().update(schema.releases).set({ purgedAt: new Date() }).where(inArray(schema.releases.id, releases.map(r => r.id)))
      await ctx.log('system', `${releases.length} release(s) supprimée(s) de l'hôte (${formatBytes(bytes)}). Données runtime conservées : ${job.paths.runtimeRoot}/${job.project.slug}`)
    }
    await db().update(schema.projectTargets).set({ portainerStackId: null, currentReleaseId: null, observedImages: {}, watchtowerApplied: null, watchtowerImageApplied: null, watchtowerPausedAt: null, healthState: null }).where(eq(schema.projectTargets.id, job.target.id))
    // Réseaux supprimés avec la stack : sous-réseaux attribués rendus à la plage (ceux fixés à la main restent).
    const freed = await releaseTargetSubnets(job.target.id).catch(async (err) => {
      await ctx.log('system', `Sous-réseaux non libérés : ${msg(err)}`, 'warn')
      return 0
    })
    if (freed) await ctx.log('system', `${freed} sous-réseau(x) rendu(s) à la plage de l'endpoint`)
    await ctx.transition('DELETED')
    // Suppression définitive du projet : retiré de la plateforme après sa dernière stack.
    if (job.d.options?.deleteProject) {
      await ctx.log('system', 'Suppression définitive du projet : retrait de la plateforme après la dernière stack')
      const removed = await finishProjectDeletion(job.project.id).catch(async (err) => {
        await ctx.log('system', `Retrait du projet impossible : ${msg(err)}`, 'error')
        return false
      })
      if (removed) await audit({ actorLabel: 'system', action: 'project.delete', targetType: 'project', targetId: job.project.id, projectId: job.project.id, outcome: 'success', details: { slug: job.project.slug, name: job.project.name } })
    }
    return
  }

  if (!stackId || !stackName) throw new Error('Aucune stack déployée pour cette cible')
  await ctx.transition('DEPLOYING')
  if (action === 'stop') {
    await p.stopStack(conn, stackId, epId)
    await ctx.log('portainer', `Stack ${stackName} arrêtée`)
    await ctx.transition('STOPPED')
    return
  }
  if (action === 'start') {
    await p.startStack(conn, stackId, epId)
    await ctx.log('portainer', `Stack ${stackName} démarrée`)
  }
  else if (action === 'restart') {
    const containers = await p.stackContainers(conn, epId, stackName)
    for (const c of containers) {
      await p.restartContainer(conn, epId, c.id)
      await ctx.log('portainer', `Conteneur ${c.name} redémarré`, 'info', c.service ?? undefined)
    }
  }
  const [current] = job.target.currentReleaseId ? await db().select().from(schema.releases).where(eq(schema.releases.id, job.target.currentReleaseId)) : []
  const services = (current?.analysis as { services?: string[] } | undefined)?.services
    ?? [...new Set((await p.stackContainers(conn, epId, stackName)).map(c => c.service).filter((s): s is string => !!s))]
  await ctx.transition('HEALTH_CHECKING')
  const h = await checkHealth(ctx, job, conn, stackName, services)
  await ctx.transition(h.outcome, h.outcome === 'HEALTHY' ? undefined : `Services en échec : ${h.services.filter(s => s.state !== 'healthy' && s.state !== 'running').map(s => s.service).join(', ')}`)
}

export async function runPipeline(ctx: PipelineContext): Promise<void> {
  const job = await loadJob(ctx.deploymentId)
  if (job.d.action === 'migrate') return runMigration(ctx, job)
  if (job.d.action === 'deploy' || job.d.action === 'redeploy') {
    try {
      return await runDeploy(ctx, job)
    }
    catch (err) {
      // Mise à niveau interrompue (build, validation, déploiement) : état précédent restauré.
      if (job.d.options?.upgrade) await rollbackUpgrade(ctx, job, null, msg(err)).catch(e => ctx.log('system', `Restauration après échec de la mise à niveau impossible : ${msg(e)}`, 'error'))
      throw err
    }
  }
  return runLifecycle(ctx, job)
}

/**
 * Mise à niveau d'images en échec : surcharges d'images, Compose final et images de la
 * release restaurés ; si la stack a déjà été déployée, elle l'est de nouveau avec les
 * images précédentes et contrôlée.
 */
async function rollbackUpgrade(ctx: PipelineContext, job: Job, stackName: string | null, failure: string) {
  const up = job.d.options!.upgrade!
  const [cur] = await db().select({ composeOverrides: schema.projectTargets.composeOverrides }).from(schema.projectTargets).where(eq(schema.projectTargets.id, job.target.id))
  await db().update(schema.projectTargets).set({ composeOverrides: { ...(cur?.composeOverrides ?? {}), images: up.previousImages, ...(up.previousPgData ? { pgData: up.previousPgData } : {}) } }).where(eq(schema.projectTargets.id, job.target.id))
  if (job.release && up.previousComposeFinal) {
    await db().update(schema.releases).set({ composeFinal: up.previousComposeFinal, images: up.previousReleaseImages }).where(eq(schema.releases.id, job.release.id))
  }
  await ctx.log('system', `Mise à niveau annulée : images précédentes rétablies (${up.services.map(s => `${s.service} ${s.from}`).join(', ')})`, 'warn')
  // Stack déjà déployée avec les nouvelles images : retour aux précédentes.
  const deployed = stackName && up.previousComposeFinal && (ctx.status === 'FAILED' || ['DEPLOYING', 'HEALTH_CHECKING'].includes(ctx.status))
  if (!deployed) {
    // Migration PostgreSQL interrompue sans Compose précédent : la stack arrêtée est relancée telle quelle.
    if (job.d.options?.pgMigration && job.target.portainerStackId) {
      await portainer().startStack(await connectionFor(job.serverRow), job.target.portainerStackId, job.endpoint.portainerEndpointId)
        .then(() => ctx.log('system', 'Stack relancée sur les données d\'origine', 'warn'), e => ctx.log('system', `Relance de la stack impossible : ${msg(e)}`, 'error'))
    }
    return
  }
  if (ctx.status !== 'FAILED') await ctx.transition('FAILED', failure)
  await ctx.transition('ROLLING_BACK')
  try {
    const conn = await connectionFor(job.serverRow)
    // Données éventuellement réécrites par la nouvelle version : remises dans l'état d'avant.
    if (up.backup?.dir) await restoreVolumes(ctx, job, conn)
    // Images précédentes présentes sur l'hôte (elles tournaient) : pas de récupération au registre,
    // qui échouerait pour une image qui n'y est plus.
    await deployStack(ctx, job, conn, stackName, up.previousComposeFinal!, { pull: false })
    const rb = await checkHealth(ctx, job, conn, stackName, Object.keys(up.previousReleaseImages))
    // Retour partiel (un service seulement) : pas un retour réussi. Cause fréquente : données déjà
    // écrites par la nouvelle version, illisibles par l'ancienne (Valkey/Redis, bases).
    const broken = rb.services.filter(s => s.state !== 'healthy' && s.state !== 'running').map(s => s.service)
    if (broken.length) {
      const upgraded = broken.filter(s => up.services.some(u => u.service === s))
      throw new Error(`les images précédentes ne démarrent pas pour ${broken.join(', ')}${upgraded.length ? ` — données probablement réécrites par la nouvelle version (format illisible par l'ancienne) : ${up.backup ? 'restauration de la sauvegarde impossible, voir ci-dessus' : 'sans sauvegarde préalable, remettre la nouvelle version de ce service seul, ou vider ses données s\'il s\'agit d\'un cache'}` : ''}`)
    }
    await afterActivation(ctx, job, conn, stackName).catch(err => ctx.log('system', `Référence des images non enregistrée : ${msg(err)}`, 'warn'))
    await ctx.transition('ROLLED_BACK', `${failure} — images précédentes restaurées`)
  }
  catch (err) {
    await ctx.transition('FAILED', `${failure} ; retour aux images précédentes en échec : ${msg(err)}`)
  }
}

// ---------------------------------------------------------------------------
// Migration vers un autre serveur
// ---------------------------------------------------------------------------

/**
 * Migration de la stack vers un autre serveur géré : release copiée et préparée, images
 * construites sur la cible pendant que la stack tourne encore ; arrêt sur l'origine, copie des
 * données, démarrage et contrôle sur la cible ; bascule de la cible seulement si tout est sain.
 * Sinon : stack de la cible retirée, stack d'origine redémarrée sur ses données intactes.
 */
async function runMigration(ctx: PipelineContext, job: Job) {
  const m = job.d.options!.migration!
  const release = job.release
  if (!release?.slug) throw new Error('Aucune release active à migrer')
  if (!job.paths) throw new Error(`Chemins de travail non configurés pour ${job.endpoint.name} / ${job.env.name}`)
  const p = portainer()
  const from = await sideOf(job.endpoint.id, job.env.id)
  const to = await sideOf(m.toEndpointId, job.env.id)
  if (!to.paths) throw new Error(`Chemins de travail non configurés sur ${to.server.name} pour ${job.env.name}`)
  const stackName = stackOfTarget(job)
  const fromLayout = projectLayout(job.paths, job.project.slug, job.target.projectPath)
  const dest = layoutOn(to.paths, job.project.slug, job.target.projectPath)
  const jobTo: Job = {
    ...job,
    endpoint: to.endpoint,
    server: { id: to.server.id, name: to.server.name },
    paths: to.paths,
    serverRow: to.server,
    target: { ...job.target, endpointId: to.endpoint.id, portainerStackId: null, projectPath: dest.projectPath },
  }
  // État d'origine, rétabli si la migration n'aboutit pas.
  const original = {
    stackId: job.target.portainerStackId,
    watchtower: job.target.watchtower,
    release: { remotePath: release.remotePath, composeFinal: release.composeFinal, composeDiff: release.composeDiff, images: release.images, metadata: release.metadata },
  }
  const [runnerFrom, runnerTo] = await Promise.all([runnerFor(job.endpoint.id), runnerFor(to.endpoint.id)])
  const connFrom = await from.conn()
  const connTo = await to.conn()
  const rctx = { requestId: ctx.deploymentId, actor: 'worker', deploymentId: ctx.deploymentId }
  await ctx.log('system', `Migration de ${stackName} : ${job.server.name} (${job.endpoint.name}) → ${to.server.name} (${to.endpoint.name})${dest.projectPath !== job.target.projectPath ? ` ; dossiers par défaut sur la cible (${dest.layout.projectDir})` : ''}`)

  await ctx.transition('PREPARING_FILES')
  const collected = await collectItems({ t: job, from, to, stackName, releaseSlug: release.slug, fromLayout, toLayout: dest.layout, runnerFrom })
  const items = selectedItems(collected.items, m.items)
  const skipped = collected.items.filter(i => !items.includes(i))
  await ctx.log('system', `Éléments copiés : ${items.map(i => `${i.label}${i.sizeBytes !== null ? ` (${formatBytes(i.sizeBytes)})` : ''}`).join(', ') || 'aucun'}${skipped.length ? ` ; non copiés : ${skipped.map(i => i.label).join(', ')}` : ''}`)
  for (const i of collected.ignored) await ctx.log('system', `${i.source} (${i.service}) non copié : ${i.reason}`)

  let stopped = false
  let started = false
  try {
    await ensureProjectDirs({ runner: tracedRunner(runnerTo), ctx: rctx, log: (msg, level) => ctx.log('extraction', msg, level), paths: to.paths, projectSlug: job.project.slug, projectPath: dest.projectPath, releaseSlug: release.slug })
    const rel = items.find(i => i.kind === 'release')
    if (rel) await copyItem({ from, to }, rel, msg => ctx.log('extraction', msg))
    const prep = await prepareFiles(ctx, jobTo, runnerTo)
    const analysis = await revalidate(ctx, jobTo, await releaseSourceFiles(release), { persist: false })

    await ctx.transition('BUILDING')
    await buildImages(ctx, jobTo, runnerTo, prep, analysis)

    await ctx.transition('DEPLOYING')
    const composeFile = prep.layout.release(release.slug).composeFile
    await runnerTo.writeFile(rctx, { path: composeFile, content: analysis.finalYaml!, mode: '0640' })
    await ctx.log('portainer', `Compose final écrit sur ${to.server.name} : ${composeFile}`)
    if (original.stackId) {
      await p.stopStack(connFrom, original.stackId, job.endpoint.portainerEndpointId)
      stopped = true
      await ctx.log('portainer', `Stack ${stackName} arrêtée sur ${job.server.name} : copie des données`)
    }
    for (const item of items.filter(i => i.kind !== 'release')) await copyItem({ from, to }, item, msg => ctx.log('service', msg))

    started = true
    const stackIdTo = await deployStack(ctx, jobTo, connTo, stackName, analysis.finalYaml!, { record: false }).catch(async (err) => {
      await suggestImageSources(ctx, err)
      throw err
    })
    await ctx.transition('HEALTH_CHECKING')
    const health = await checkHealth(ctx, jobTo, connTo, stackName, analysis.services)
    if (health.outcome !== 'HEALTHY') {
      throw new Error(`Services en échec sur ${to.server.name} : ${health.services.filter(s => s.state !== 'healthy' && s.state !== 'running').map(s => `${s.service} (${s.detail})`).join(', ')}`)
    }

    // Bascule : la cible appartient désormais au serveur de destination.
    const releases = await db().select({ slug: schema.releases.slug }).from(schema.releases).where(and(eq(schema.releases.targetId, job.target.id), isNull(schema.releases.purgedAt), isNotNull(schema.releases.slug)))
    const migratedFrom: MigratedFrom = {
      endpointId: job.endpoint.id,
      serverName: job.server.name,
      endpointName: job.endpoint.name,
      stackId: original.stackId,
      stackName,
      projectPath: job.target.projectPath,
      volumes: collected.items.filter(i => i.kind === 'volume').map(i => i.source),
      dataDir: collected.items.some(i => i.kind === 'data') ? fromLayout.runtimeDir : null,
      releaseSlugs: releases.map(r => r.slug!),
      at: new Date().toISOString(),
      deploymentId: ctx.deploymentId,
      cleanedAt: null,
    }
    await db().update(schema.projectTargets).set({ endpointId: to.endpoint.id, portainerStackId: stackIdTo, stackName, projectPath: dest.projectPath, migratedFrom }).where(eq(schema.projectTargets.id, job.target.id))
    await db().update(schema.releases).set({ activatedAt: new Date() }).where(eq(schema.releases.id, release.id))
    await recordSubnets(ctx, jobTo, connTo, stackName, release.composeSource ?? '')
    await afterActivation(ctx, jobTo, connTo, stackName).catch(err => ctx.log('system', `Référence des images non enregistrée : ${msg(err)}`, 'warn'))
    await applyNginxSites(ctx, jobTo, connTo, stackName).catch(err => ctx.log('system', `Configuration nginx non appliquée sur ${to.server.name} : ${msg(err)}`, 'error'))
    await ctx.log('system', `Migration terminée : ${stackName} tourne sur ${to.server.name}. L'ancienne stack reste arrêtée sur ${job.server.name} avec ses données (à nettoyer depuis la page du projet)`)
    await ctx.transition('HEALTHY')
  }
  catch (err) {
    await revertMigration(ctx, job, { from: connFrom, to: connTo, toServer: to.server.name, toEndpoint: to.endpoint.portainerEndpointId, stackName, original, stopped, started }, msg(err))
  }
}

/** Sous-réseaux réellement créés sur la cible : enregistrés pour la cible (plus ceux de l'origine). */
async function recordSubnets(ctx: PipelineContext, job: Job, conn: PortainerConnection, stackName: string, composeText: string) {
  await db().delete(schema.networkAllocations).where(eq(schema.networkAllocations.targetId, job.target.id))
  if (!job.endpoint.networkPool) return
  for (const key of composeNetworkKeys(composeText)) {
    const n = await portainer().inspectNetwork(conn, job.endpoint.portainerEndpointId, `${stackName}_${key}`).catch(() => null)
    const subnet = n?.ipam.config[0]?.subnet
    if (subnet) await pinSubnet(job.endpoint.id, job.target.id, key, subnet, { pinned: false }).catch(err => ctx.log('system', `Sous-réseau de ${key} non enregistré : ${msg(err)}`, 'warn'))
  }
}

async function revertMigration(ctx: PipelineContext, job: Job, s: { from: PortainerConnection, to: PortainerConnection, toServer: string, toEndpoint: number, stackName: string, original: { stackId: number | null, watchtower: unknown, release: Record<string, unknown> }, stopped: boolean, started: boolean }, failure: string) {
  // Release et Watchtower tels qu'avant (la cible, elle, n'a jamais quitté l'origine).
  await db().update(schema.releases).set(s.original.release).where(eq(schema.releases.id, job.release!.id))
  await db().update(schema.projectTargets).set({ watchtower: s.original.watchtower as typeof job.target.watchtower }).where(eq(schema.projectTargets.id, job.target.id))
  if (s.started) {
    const created = await portainer().findStack(s.to, s.stackName, s.toEndpoint).catch(() => null)
    if (created) {
      await portainer().deleteStack(s.to, created.id, s.toEndpoint)
        .then(() => ctx.log('portainer', `Stack ${s.stackName} retirée de ${s.toServer} (données copiées laissées sur place)`, 'warn'), e => ctx.log('portainer', `Retrait de la stack sur ${s.toServer} impossible : ${msg(e)}`, 'error'))
    }
  }
  if (!s.stopped) {
    await ctx.log('system', `Migration interrompue avant l'arrêt de la stack : ${s.stackName} est restée en service sur ${job.server.name}`, 'warn')
    throw new Error(failure)
  }
  if (ctx.status === 'HEALTH_CHECKING') await ctx.transition('FAILED', failure)
  await ctx.transition('ROLLING_BACK')
  try {
    await portainer().startStack(s.from, s.original.stackId!, job.endpoint.portainerEndpointId)
    await ctx.log('portainer', `Stack ${s.stackName} redémarrée sur ${job.server.name}`, 'warn')
    const [current] = await db().select({ analysis: schema.releases.analysis }).from(schema.releases).where(eq(schema.releases.id, job.release!.id))
    const services = (current?.analysis as { services?: string[] } | undefined)?.services ?? []
    const h = await checkHealth(ctx, job, s.from, s.stackName, services)
    const broken = h.services.filter(x => x.state !== 'healthy' && x.state !== 'running').map(x => x.service)
    if (broken.length) throw new Error(`services en échec après le redémarrage : ${broken.join(', ')}`)
    await ctx.transition('ROLLED_BACK', `${failure} — stack redémarrée sur ${job.server.name}, données d'origine intactes`)
  }
  catch (err) {
    await ctx.transition('FAILED', `${failure} ; redémarrage sur ${job.server.name} en échec : ${msg(err)}`)
  }
}
