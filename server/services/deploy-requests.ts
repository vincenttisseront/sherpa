/**
 * Demandes de déploiement et d'actions de cycle de vie. L'analyse est
 * refaite côté serveur au moment de la demande : rien n'est mis en file si
 * le Compose n'est pas conforme. Une seule opération active par cible.
 */
import type { DeploymentOptions } from '../db/schema'
import { type Progress, noProgress } from '../utils/progress'
import { and, eq, inArray, max } from 'drizzle-orm'
import { createError } from 'h3'
import { ACTIVE_STATUSES } from '../../shared/utils/deployment-status'
import { db, schema } from '../db/client'
import type { AnalysisResult, PortApproval } from '../lib/compose/analyze'
import { gateAndEnqueue } from './deploy-gate'
import { releaseSlug } from '../../shared/utils/release'
import { type TargetRow, analyzeForTarget, getTargetOr404, sourceFromUpload } from './projects'
import { RELAUNCHABLE } from '../../shared/schemas/deployments'
import { getUpload } from './uploads'
import { imageSourceIssues } from './image-sources'
import { getProjectSource, previewGithub } from './sources'

/** Projet archivé : aucun déploiement ni action sur ses cibles (sauf la suppression d'une stack). */
export function assertProjectActive(t: TargetRow) {
  if (t.project.archivedAt) throw createError({ statusCode: 409, statusMessage: 'Projet archivé : le désarchiver pour déployer' })
}

export async function assertTargetIdle(targetId: string) {
  const busy = await db().$count(schema.deployments, and(eq(schema.deployments.targetId, targetId), inArray(schema.deployments.status, [...ACTIVE_STATUSES])))
  if (busy) throw createError({ statusCode: 409, statusMessage: 'Une opération est déjà en cours sur cette cible' })
}

export interface DeployRequest {
  uploadId: string
  composePath: string
  portApprovals: PortApproval[]
  idempotencyKey: string
  userId: string | null
  progress?: Progress
  options?: DeploymentOptions
}

/** Analyse sans rien enregistrer (prévisualisation). Le slug de release est provisoire. */
export async function previewDeployment(t: TargetRow, uploadId: string, composePath: string, portApprovals: PortApproval[], progress: Progress = noProgress): Promise<AnalysisResult> {
  await progress.step(`Lecture de ${composePath} dans l'archive`, 1, 2)
  const upload = await getUpload(uploadId)
  if (!upload) throw createError({ statusCode: 404, statusMessage: 'Archive introuvable' })
  const src = await sourceFromUpload(upload, composePath)
  await progress.step('Analyse du Compose : sécurité, ports, volumes, réseaux, Compose final', 2, 2)
  const [{ n }] = await db().select({ n: max(schema.releases.number) }).from(schema.releases).where(eq(schema.releases.targetId, t.target.id)) as [{ n: number | null }]
  const analysis = await analyzeForTarget(t, { ...src, releaseSlug: `r-${String((n ?? 0) + 1).padStart(4, '0')}-xxxxxx`, portApprovals })
  // Images que leur registre ne sert pas : signalées maintenant, avec les sources équivalentes.
  analysis.issues.push(...await imageSourceIssues(analysis.images, analysis.builds.map(b => b.service)))
  return analysis
}

export async function createDeployment(t: TargetRow, req: DeployRequest): Promise<{ deploymentId: string, analysis: AnalysisResult, duplicate: boolean }> {
  assertProjectActive(t)
  const [existing] = await db().select({ id: schema.deployments.id }).from(schema.deployments).where(eq(schema.deployments.idempotencyKey, req.idempotencyKey))
  if (existing) return { deploymentId: existing.id, analysis: null as unknown as AnalysisResult, duplicate: true }
  await assertTargetIdle(t.target.id)
  const progress = req.progress ?? noProgress
  await progress.step(`Lecture de ${req.composePath} dans l'archive`, 1, 3)
  const upload = await getUpload(req.uploadId)
  if (!upload) throw createError({ statusCode: 404, statusMessage: 'Archive introuvable' })
  const src = await sourceFromUpload(upload, req.composePath)

  await progress.step('Nouvelle analyse avec les politiques en vigueur et création de la release', 2, 3)
  return db().transaction(async (tx) => {
    // Numéro de release attribué sous verrou de ligne sur la cible (sans verrou de clé : l'allocation de réseau de l'analyse, sur une autre connexion, référence cette ligne).
    await tx.select({ id: schema.projectTargets.id }).from(schema.projectTargets).where(eq(schema.projectTargets.id, t.target.id)).for('no key update')
    const [{ n }] = await tx.select({ n: max(schema.releases.number) }).from(schema.releases).where(eq(schema.releases.targetId, t.target.id)) as [{ n: number | null }]
    const [release] = await tx.insert(schema.releases).values({
      targetId: t.target.id,
      number: (n ?? 0) + 1,
      sourceKind: 'zip',
      uploadId: upload.id,
      archiveSha256: upload.sha256,
      composePath: src.composePath,
      createdBy: req.userId,
    }).returning()
    const slug = releaseSlug(release!.number, release!.id)
    const analysis = await analyzeForTarget(t, { ...src, releaseSlug: slug, portApprovals: req.portApprovals })
    if (!analysis.ok) {
      // Annule la transaction : aucune release ni déploiement n'est créé.
      throw createError({ statusCode: 422, statusMessage: 'Compose non conforme', data: { analysis } })
    }
    await tx.update(schema.releases).set({
      slug,
      composeSource: src.composeText,
      composeFinal: analysis.finalYaml,
      composeDiff: analysis.diff,
      images: analysis.images,
      analysis: {
        services: analysis.services,
        approvals: req.portApprovals,
        ports: analysis.ports,
        mounts: analysis.mounts,
        networks: analysis.networks,
        changes: analysis.changes,
        issues: analysis.issues,
        exposures: analysis.exposures,
        builds: analysis.builds.map(b => ({ service: b.service, context: b.context, dockerfile: b.dockerfile, image: b.image })),
      },
      // Clés des env_file (sans valeurs) : nécessaires à la revalidation par le worker.
      // Archive d'une release GitHub : sa provenance, pour reconstruire sur une release suivante.
      metadata: { envFileKeys: src.envFileKeys, ...((upload.report as { githubRelease?: unknown }).githubRelease ? { githubRelease: (upload.report as { githubRelease?: unknown }).githubRelease } : {}) },
    }).where(eq(schema.releases.id, release!.id))
    const [d] = await tx.insert(schema.deployments).values({
      targetId: t.target.id,
      releaseId: release!.id,
      action: 'deploy',
      status: 'QUEUED',
      idempotencyKey: req.idempotencyKey,
      requestedBy: req.userId,
      queuedAt: new Date(),
      options: req.options ?? {},
    }).returning({ id: schema.deployments.id })
    return { deploymentId: d!.id, analysis, duplicate: false }
  }).then(async (r) => {
    await progress.step('Mise en file du déploiement', 3, 3)
    await enqueueOrCancel({ deploymentId: r.deploymentId, projectId: t.project.id, environmentId: t.env.id }, req.idempotencyKey)
    return r
  })
}

/** redeploy : release active rejouée avec la configuration actuelle (Watchtower, politiques) et images des registres retirées. */
export type LifecycleAction = 'stop' | 'start' | 'restart' | 'delete' | 'redeploy' | 'migrate'

/**
 * Mise en file d'une opération déjà enregistrée. Si la file la refuse, l'opération est
 * annulée avec le motif : sinon elle resterait « en file » et bloquerait la cible.
 */
async function enqueueOrCancel(data: Parameters<typeof gateAndEnqueue>[0], idempotencyKey: string): Promise<void> {
  try {
    await gateAndEnqueue(data, idempotencyKey)
  }
  catch (err) {
    // Refus de la porte (fenêtre, date) : l'opération est déjà annulée avec son motif.
    if ((err as { statusCode?: number }).statusCode && (err as { statusCode: number }).statusCode < 500) throw err
    const message = `Mise en file impossible : ${(err as Error).message}`.slice(0, 500)
    await db().update(schema.deployments).set({ status: 'CANCELLED', error: message, finishedAt: new Date() }).where(eq(schema.deployments.id, data.deploymentId))
    throw createError({ statusCode: 503, statusMessage: message })
  }
}

export async function createLifecycleAction(t: TargetRow, action: LifecycleAction, userId: string | null, idempotencyKey: string, options: DeploymentOptions = {}): Promise<string> {
  const [existing] = await db().select({ id: schema.deployments.id }).from(schema.deployments).where(eq(schema.deployments.idempotencyKey, idempotencyKey))
  if (existing) return existing.id
  if (action !== 'delete') assertProjectActive(t)
  await assertTargetIdle(t.target.id)
  if (action !== 'delete' && !t.target.portainerStackId) throw createError({ statusCode: 409, statusMessage: 'Aucune stack déployée pour cette cible' })
  if ((action === 'redeploy' || action === 'migrate') && !t.target.currentReleaseId) throw createError({ statusCode: 409, statusMessage: 'Aucune release active à redéployer' })
  const [d] = await db().insert(schema.deployments).values({
    targetId: t.target.id,
    releaseId: t.target.currentReleaseId,
    action,
    status: 'QUEUED',
    idempotencyKey,
    requestedBy: userId,
    queuedAt: new Date(),
    options,
  }).returning({ id: schema.deployments.id })
  await enqueueOrCancel({ deploymentId: d!.id, projectId: t.project.id, environmentId: t.env.id }, idempotencyKey)
  return d!.id
}

/**
 * Relance d'un déploiement avec les mêmes paramètres : même release (Compose, source, ports
 * approuvés), revalidée avec les politiques en vigueur. Images construites reprises telles
 * quelles ou reconstruites ; images des registres récupérées à nouveau ou non.
 */
export async function relaunchDeployment(deploymentId: string, input: { rebuild: boolean, cleanBuild: boolean, pull: boolean }, userId: string | null, idempotencyKey: string): Promise<string> {
  const [existing] = await db().select({ id: schema.deployments.id }).from(schema.deployments).where(eq(schema.deployments.idempotencyKey, idempotencyKey))
  if (existing) return existing.id
  const [src] = await db().select({ d: schema.deployments, slug: schema.releases.slug }).from(schema.deployments)
    .leftJoin(schema.releases, eq(schema.releases.id, schema.deployments.releaseId))
    .where(eq(schema.deployments.id, deploymentId))
  if (!src) throw createError({ statusCode: 404, statusMessage: 'Déploiement introuvable' })
  if (!RELAUNCHABLE.includes(src.d.action) || !src.d.releaseId || !src.slug) throw createError({ statusCode: 409, statusMessage: 'Seul un déploiement de release peut être relancé' })
  const t = await getTargetOr404(src.d.targetId)
  assertProjectActive(t)
  await assertTargetIdle(t.target.id)
  const options: DeploymentOptions = { ...(input.rebuild ? (input.cleanBuild ? { cleanBuild: true } : {}) : { skipBuild: true }), ...(input.pull ? {} : { noPull: true }) }
  const [d] = await db().insert(schema.deployments).values({
    targetId: t.target.id,
    releaseId: src.d.releaseId,
    action: 'redeploy',
    status: 'QUEUED',
    idempotencyKey,
    requestedBy: userId,
    queuedAt: new Date(),
    options,
  }).returning({ id: schema.deployments.id })
  await enqueueOrCancel({ deploymentId: d!.id, projectId: t.project.id, environmentId: t.env.id }, idempotencyKey)
  return d!.id
}

export interface GithubDeployRequest {
  refType?: 'branch' | 'tag' | 'commit'
  ref?: string
  /** Commit exact présenté à l'analyse : on déploie celui-là, même si la branche a avancé. */
  commitSha?: string
  portApprovals: PortApproval[]
  idempotencyKey: string
  userId: string | null
  progress?: Progress
  options?: DeploymentOptions
}

export async function createGithubDeployment(t: TargetRow, req: GithubDeployRequest): Promise<{ deploymentId: string, duplicate: boolean, commitSha: string }> {
  assertProjectActive(t)
  const [existing] = await db().select({ id: schema.deployments.id }).from(schema.deployments).where(eq(schema.deployments.idempotencyKey, req.idempotencyKey))
  if (existing) return { deploymentId: existing.id, duplicate: true, commitSha: '' }
  await assertTargetIdle(t.target.id)
  const source = await getProjectSource(t.project.id)
  // Résolution et lecture GitHub hors transaction (appels réseau).
  const progress = req.progress ?? noProgress
  const pv = await previewGithub(t, { refType: req.refType, ref: req.ref, commitSha: req.commitSha, approvals: req.portApprovals, releaseSlug: 'r-0000-000000', progress })
  await progress.step('Création de la release au commit figé', 4, 5)

  const r = await db().transaction(async (tx) => {
    await tx.select({ id: schema.projectTargets.id }).from(schema.projectTargets).where(eq(schema.projectTargets.id, t.target.id)).for('no key update')
    const [{ n }] = await tx.select({ n: max(schema.releases.number) }).from(schema.releases).where(eq(schema.releases.targetId, t.target.id)) as [{ n: number | null }]
    const [release] = await tx.insert(schema.releases).values({
      targetId: t.target.id,
      number: (n ?? 0) + 1,
      sourceKind: 'github',
      repository: pv.repository,
      sourceRef: `${pv.refType}:${pv.ref}`,
      commitSha: pv.commit.sha,
      composePath: pv.composePath,
      createdBy: req.userId,
    }).returning()
    const slug = releaseSlug(release!.number, release!.id)
    const analysis = await analyzeForTarget(t, { composeText: pv.composeText, composePath: pv.composePath, files: pv.files, releaseSlug: slug, portApprovals: req.portApprovals, sourceKind: 'github', envFileKeys: pv.envFileKeys })
    for (const i of pv.analysis.issues.filter(x => x.code.startsWith('github.'))) analysis.issues.push(i)
    if (!analysis.ok || !pv.analysis.ok) throw createError({ statusCode: 422, statusMessage: 'Compose non conforme', data: { analysis } })
    await tx.update(schema.releases).set({
      slug,
      composeSource: pv.composeText,
      composeFinal: analysis.finalYaml,
      composeDiff: analysis.diff,
      images: analysis.images,
      metadata: { github: { commit: pv.commit, submodules: source?.submodules ? pv.submodules.filter(s => s.supported) : [] }, envFileKeys: pv.envFileKeys },
      analysis: {
        services: analysis.services, approvals: req.portApprovals, ports: analysis.ports, mounts: analysis.mounts, networks: analysis.networks,
        changes: analysis.changes, issues: analysis.issues, exposures: analysis.exposures,
        builds: analysis.builds.map(b => ({ service: b.service, context: b.context, dockerfile: b.dockerfile, image: b.image })),
      },
    }).where(eq(schema.releases.id, release!.id))
    const [d] = await tx.insert(schema.deployments).values({ targetId: t.target.id, releaseId: release!.id, action: 'deploy', status: 'QUEUED', idempotencyKey: req.idempotencyKey, requestedBy: req.userId, queuedAt: new Date(), options: req.options ?? {} }).returning({ id: schema.deployments.id })
    return { deploymentId: d!.id, duplicate: false, commitSha: pv.commit.sha }
  })
  await progress.step('Mise en file du déploiement', 5, 5)
  await enqueueOrCancel({ deploymentId: r.deploymentId, projectId: t.project.id, environmentId: t.env.id }, req.idempotencyKey)
  return r
}
