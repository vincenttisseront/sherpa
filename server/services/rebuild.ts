/**
 * Reconstruction d'une cible sur la dernière version de sa source, en un geste :
 * - dépôt GitHub suivi par branche : dernier commit de la branche ;
 * - dépôt GitHub suivi par tag : dernière release publiée (hors préversions), le tag suivi avance ;
 * - archive importée d'une release GitHub : fichier équivalent de la dernière release ;
 * - autre source (archive déposée, Compose) : même release reconstruite.
 * Les ports approuvés de la release active sont repris ; une nouvelle release qui en demande
 * d'autres est refusée (passer par « Nouveau déploiement »). Build propre facultatif.
 */
import { and, eq, inArray, isNotNull } from 'drizzle-orm'
import { createError } from 'h3'
import type { AutoRebuildState, RebuildPlan } from '../../shared/schemas/rebuild'
import { ACTIVE_STATUSES } from '../../shared/utils/deployment-status'
import { db, schema } from '../db/client'
import { type GithubSource, GithubError } from '../lib/github'
import type { PortApproval } from '../lib/compose/analyze'
import { matchingArchive } from '../lib/release-match'
import { type Progress, noProgress } from '../utils/progress'
import { createDeployment, createGithubDeployment, createLifecycleAction } from './deploy-requests'
import { importReleaseArchive, releaseView, sourceFor } from './github-releases'
import { type TargetRow, getTargetOr404, targetScope } from './projects'
import { emitNotification } from './notifications'
import { audit } from '../utils/audit'
import { getProjectSource, github, githubCredentials } from './sources'
import type { GithubReleaseOrigin } from './uploads'

type Release = typeof schema.releases.$inferSelect

const unprocessable = (err: unknown): never => {
  throw err instanceof GithubError ? createError({ statusCode: 422, statusMessage: `GitHub : ${err.message}` }) : err
}
const firstLine = (s: string) => s.split('\n')[0]!.slice(0, 120)

async function currentRelease(t: TargetRow): Promise<Release | null> {
  if (!t.target.currentReleaseId) return null
  const [r] = await db().select().from(schema.releases).where(eq(schema.releases.id, t.target.currentReleaseId))
  return r ?? null
}

/** Dernière release publiée (hors préversions, sinon la plus récente). */
async function latestRelease(src: GithubSource) {
  const list = await github().releases(src, 20)
  return list.find(r => !r.prerelease) ?? list[0] ?? null
}

interface Resolved { plan: RebuildPlan, cur: Release | null, src: GithubSource | null, origin: GithubReleaseOrigin | null }

/** `branch` : branche propre à l'environnement (webhook), à la place de la référence de la source du projet. */
async function resolve(t: TargetRow, branch?: string | null): Promise<Resolved> {
  const cur = await currentRelease(t)
  const source = await getProjectSource(t.project.id)
  const builds = ((cur?.analysis as { builds?: unknown[] } | null)?.builds ?? []).length
  const origin = (cur?.metadata as { githubRelease?: GithubReleaseOrigin } | null)?.githubRelease ?? null
  const base = { builds, warnings: [] as string[] }
  if (!cur) throw createError({ statusCode: 409, statusMessage: 'Aucune release active : faire un premier déploiement' })

  // Dépôt GitHub du projet (release active issue de GitHub).
  if (cur.sourceKind === 'github' && source?.kind === 'github' && source.repository && (branch || (source.ref && source.refType !== 'commit'))) {
    const src = await githubCredentials(source)
    const current = { label: `${cur.sourceRef?.replace(/^\w+:/, '') ?? '?'} @ ${cur.commitSha?.slice(0, 7) ?? '?'}`, ref: cur.commitSha ?? '', at: cur.createdAt.toISOString(), url: null }
    try {
      if (branch || source.refType === 'branch') {
        const ref = branch ?? source.ref!
        const c = await github().resolve(src, 'branch', ref)
        return { cur, src, origin: null, plan: { ...base, mode: 'github-branch', source: `${source.repository}, branche ${ref}`, current, latest: { label: `${ref} @ ${c.sha.slice(0, 7)} — ${firstLine(c.message)}`, ref: c.sha, at: c.date, url: c.htmlUrl }, upToDate: c.sha === cur.commitSha } }
      }
      const rel = await latestRelease(src)
      const tag = rel?.tag ?? source.ref!
      const currentTag = cur.sourceRef?.startsWith('tag:') ? cur.sourceRef.slice(4) : source.ref!
      if (!rel) base.warnings.push('Aucune release publiée : le tag suivi est reconstruit')
      return { cur, src, origin: null, plan: { ...base, mode: 'github-release', source: `${source.repository}, releases (tag suivi ${source.ref})`, current: { ...current, label: currentTag }, latest: { label: rel ? `${rel.tag}${rel.name && rel.name !== rel.tag ? ` — ${rel.name}` : ''}` : tag, ref: tag, at: rel?.publishedAt ?? null, url: rel?.htmlUrl ?? null }, upToDate: tag === currentTag } }
    }
    catch (err) {
      unprocessable(err)
    }
  }

  // Archive importée d'une release GitHub.
  if (origin) {
    const { src } = await sourceFor(t.project.id, origin.apiUrl, origin.repository, null)
    try {
      const rel = await latestRelease(src)
      if (!rel) throw createError({ statusCode: 422, statusMessage: `Plus aucune release publiée sur ${origin.repository}` })
      const files = releaseView(rel, origin.repository).files
      const match = matchingArchive({ key: origin.archiveKey, name: origin.archiveName, tag: origin.tag }, files, rel.tag)
      if (!match) base.warnings.push(`Aucun fichier équivalent à « ${origin.archiveName} » dans la release ${rel.tag}`)
      return { cur, src, origin, plan: { ...base, mode: 'release-archive', source: `${origin.repository}, releases (${origin.archiveName})`, current: { label: `${origin.tag} (${origin.archiveName})`, ref: origin.tag, at: cur.createdAt.toISOString(), url: null }, latest: { label: `${rel.tag}${match ? ` (${match.name})` : ''}`, ref: rel.tag, at: rel.publishedAt, url: rel.htmlUrl }, upToDate: rel.tag === origin.tag } }
    }
    catch (err) {
      unprocessable(err)
    }
  }

  const label = `release ${cur.number}${cur.commitSha ? ` @ ${cur.commitSha.slice(0, 7)}` : ''}`
  return { cur, src: null, origin: null, plan: { ...base, mode: 'same', source: cur.sourceKind === 'github' ? 'dépôt GitHub (commit fixe)' : 'archive déposée ou Compose', current: { label, ref: cur.id, at: cur.createdAt.toISOString(), url: null }, latest: null, upToDate: true } }
}

export async function rebuildPlan(t: TargetRow, branch?: string | null): Promise<RebuildPlan> {
  return (await resolve(t, branch)).plan
}

export async function startRebuild(t: TargetRow, input: { cleanBuild: boolean, userId: string | null, idempotencyKey: string, progress?: Progress, branch?: string | null }): Promise<{ deploymentId: string, plan: RebuildPlan }> {
  const progress = input.progress ?? noProgress
  await progress.step('Recherche de la dernière version de la source')
  const { plan, cur, origin } = await resolve(t, input.branch)
  const approvals = ((cur?.analysis as { approvals?: PortApproval[] } | null)?.approvals ?? [])
  const options = input.cleanBuild ? { cleanBuild: true } : {}
  const common = { portApprovals: approvals, idempotencyKey: input.idempotencyKey, userId: input.userId, progress, options }
  const refused = (err: unknown): never => {
    const e = err as { statusCode?: number, statusMessage?: string }
    if (e.statusCode === 422 && e.statusMessage === 'Compose non conforme') {
      throw createError({ statusCode: 422, statusMessage: 'La nouvelle version demande une revue (ports à approuver, règles non respectées) : la déployer par « Nouveau déploiement »', data: (err as { data?: unknown }).data })
    }
    throw err
  }

  if (plan.mode === 'github-branch') {
    // Commit présenté au plan, la branche restant la référence de la release.
    const branch = input.branch ?? (await getProjectSource(t.project.id))?.ref ?? undefined
    const r = await createGithubDeployment(t, { refType: 'branch', ref: branch, commitSha: plan.latest!.ref, ...common }).catch(refused)
    return { deploymentId: r.deploymentId, plan }
  }
  if (plan.mode === 'github-release') {
    const r = await createGithubDeployment(t, { refType: 'tag', ref: plan.latest!.ref, ...common }).catch(refused)
    // Le tag suivi avance : la source du projet désigne désormais cette release.
    await db().update(schema.projectSources).set({ ref: plan.latest!.ref }).where(eq(schema.projectSources.projectId, t.project.id))
    return { deploymentId: r.deploymentId, plan }
  }
  if (plan.mode === 'release-archive') {
    const rel = await sourceFor(t.project.id, origin!.apiUrl, origin!.repository, null).then(({ src }) => github().release(src, plan.latest!.ref)).catch(unprocessable)
    const match = matchingArchive({ key: origin!.archiveKey, name: origin!.archiveName, tag: origin!.tag }, releaseView(rel, origin!.repository).files, rel.tag)
    if (!match) throw createError({ statusCode: 422, statusMessage: `Aucun fichier équivalent à « ${origin!.archiveName} » dans la release ${rel.tag} : la déployer par « Nouveau déploiement »` })
    const upload = await importReleaseArchive(t.project.id, { apiUrl: origin!.apiUrl, repository: origin!.repository, tag: rel.tag, archiveKey: match.key }, input.userId, progress)
    const r = await createDeployment(t, { uploadId: upload.id, composePath: cur!.composePath ?? 'compose.yml', ...common }).catch(refused)
    return { deploymentId: r.deploymentId, plan }
  }
  const deploymentId = await createLifecycleAction(t, 'redeploy', input.userId, input.idempotencyKey, options)
  return { deploymentId, plan }
}

// ---------------------------------------------------------------------------
// Reconstruction automatique à chaque nouvelle version
// ---------------------------------------------------------------------------

const AUTO_ACTOR = 'reconstruction automatique'

export async function setAutoRebuild(t: TargetRow, input: { enabled: boolean, cleanBuild: boolean }): Promise<AutoRebuildState> {
  if (input.enabled) {
    const plan = await rebuildPlan(t)
    if (plan.mode === 'same') throw createError({ statusCode: 422, statusMessage: 'Source sans version suivie (archive déposée, Compose, commit fixe) : rien à surveiller. Suivre une branche ou les releases d\'un dépôt GitHub.' })
  }
  const prev = t.target.autoRebuild
  // Réactivation : historique remis à zéro (une version déjà traitée peut l'être de nouveau).
  const reset = input.enabled && !prev?.enabled
  const state: AutoRebuildState = { enabled: input.enabled, cleanBuild: input.cleanBuild, lastCheckAt: reset ? null : prev?.lastCheckAt ?? null, last: reset ? null : prev?.last ?? null, error: null }
  await db().update(schema.projectTargets).set({ autoRebuild: state }).where(eq(schema.projectTargets.id, t.target.id))
  return state
}

/** Une cible : nouvelle version détectée → reconstruction (une seule tentative par version et par release de départ). */
export async function autoRebuildTarget(t: TargetRow): Promise<'started' | 'refused' | 'error' | 'up-to-date' | 'busy' | 'skipped'> {
  const state = t.target.autoRebuild
  if (!state?.enabled || t.project.archivedAt || !t.target.currentReleaseId) return 'skipped'
  const save = (patch: Partial<AutoRebuildState>) => db().update(schema.projectTargets).set({ autoRebuild: { ...state, lastCheckAt: new Date().toISOString(), ...patch } }).where(eq(schema.projectTargets.id, t.target.id))
  const busy = await db().$count(schema.deployments, and(eq(schema.deployments.targetId, t.target.id), inArray(schema.deployments.status, [...ACTIVE_STATUSES])))
  if (busy) return 'busy'
  let plan: RebuildPlan
  try {
    plan = await rebuildPlan(t)
  }
  catch (err) {
    await save({ error: (err as Error).message.slice(0, 500) })
    return 'error'
  }
  if (plan.upToDate || !plan.latest || plan.mode === 'same' || state.last?.ref === plan.latest.ref) {
    await save({ error: null })
    return 'up-to-date'
  }
  const scope = targetScope(t)
  const notify = (severity: 'info' | 'warning', title: string, summary: string, path: string) => emitNotification({
    event: 'rebuild.auto', severity, title, summary, path,
    facts: [{ label: 'Projet', value: t.project.name }, { label: 'Environnement', value: t.env.name }, { label: 'Version', value: `${plan.current?.label ?? '?'} → ${plan.latest!.label}` }],
    serverId: t.server.id, environmentId: t.env.id, projectId: t.project.id,
  })
  try {
    const r = await startRebuild(t, { cleanBuild: state.cleanBuild, userId: null, idempotencyKey: `auto-rebuild:${t.target.id}:${plan.latest.ref}@${t.target.currentReleaseId}` })
    await save({ error: null, last: { ref: plan.latest.ref, label: plan.latest.label, at: new Date().toISOString(), deploymentId: r.deploymentId, outcome: 'started', message: null } })
    await audit({ actorUserId: null, actorLabel: AUTO_ACTOR, action: 'target.rebuild', targetType: 'deployment', targetId: r.deploymentId, ...scope, outcome: 'success', details: { mode: plan.mode, from: plan.current?.label ?? null, to: plan.latest.label, auto: true, cleanBuild: state.cleanBuild } })
    await notify('info', `Reconstruction automatique : ${t.project.name} (${t.env.name})`, `Nouvelle version ${plan.latest.label} détectée : reconstruction et déploiement lancés.`, `/deployments/${r.deploymentId}`)
    return 'started'
  }
  catch (err) {
    const message = ((err as { statusMessage?: string }).statusMessage ?? (err as Error).message).slice(0, 500)
    const refused = (err as { statusCode?: number }).statusCode === 422
    // Version refusée ou en échec : pas de nouvelle tentative pour elle (la suivante sera essayée).
    await save({ error: message, last: { ref: plan.latest.ref, label: plan.latest.label, at: new Date().toISOString(), deploymentId: null, outcome: refused ? 'refused' : 'error', message } })
    await audit({ actorUserId: null, actorLabel: AUTO_ACTOR, action: 'target.rebuild', targetType: 'project_target', targetId: t.target.id, ...scope, outcome: 'failure', details: { to: plan.latest.label, auto: true, error: message } })
    await notify('warning', `Reconstruction automatique non lancée : ${t.project.name} (${t.env.name})`, `${plan.latest.label} : ${message}`, `/projects/${t.project.id}`)
    return refused ? 'refused' : 'error'
  }
}

/** Maintenance : toutes les cibles en reconstruction automatique. */
export async function runAutoRebuilds(): Promise<Record<string, number>> {
  const rows = await db().select({ id: schema.projectTargets.id, auto: schema.projectTargets.autoRebuild }).from(schema.projectTargets).where(isNotNull(schema.projectTargets.autoRebuild))
  const counts: Record<string, number> = {}
  for (const r of rows.filter(x => x.auto?.enabled)) {
    const outcome = await getTargetOr404(r.id).then(autoRebuildTarget).catch((err) => {
      console.warn(`[auto-rebuild] ${r.id} : ${(err as Error).message}`)
      return 'error' as const
    })
    counts[outcome] = (counts[outcome] ?? 0) + 1
  }
  return counts
}
