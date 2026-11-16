/**
 * Sources de projet (§7) : ZIP ou dépôt GitHub. Pour GitHub, le token est
 * chiffré et ne quitte jamais la plateforme ; le commit est résolu et figé au
 * moment de l'analyse, puis son archive suit exactement le parcours d'un ZIP.
 */
import { imageSourceIssues } from './image-sources'
import { type Progress, noProgress } from '../utils/progress'
import { eq } from 'drizzle-orm'
import { createError } from 'h3'
import { db, schema } from '../db/client'
import type { AnalysisResult, Exposure, PortApproval } from '../lib/compose/analyze'
import { isComposeFile } from '../lib/zip'
import { type GithubSource, GithubError, type ResolvedCommit, createGithubClient, normalizeApiUrl, parseGitmodules } from '../lib/github'
import { decryptSecret, encryptSecret } from '../utils/crypto'
import { env } from '../utils/env'
import { validateRelativeEntry } from '../utils/path-guard'
import { mapLimit } from '../utils/pool'
import { formatBytes } from '../../shared/utils/format'
import { MAX_COMPOSE_READ, type TargetRow, analyzeForTarget } from './projects'
import { MAX_ENV_FILE, collectEnvFiles } from './env-files'
import { type StoredUpload, storeUpload } from './uploads'

let client: ReturnType<typeof createGithubClient> | undefined
export function allowedGithubApis(): string[] {
  return env().GITHUB_ALLOWED_API_URLS.split(',').map(s => normalizeApiUrl(s)).filter(Boolean)
}
export function github() {
  client ??= createGithubClient({ allowedApiUrls: allowedGithubApis(), timeoutMs: env().GITHUB_TIMEOUT_MS, allowHttp: env().NODE_ENV !== 'production' })
  return client
}

export async function getProjectSource(projectId: string) {
  const [s] = await db().select().from(schema.projectSources).where(eq(schema.projectSources.projectId, projectId))
  return s ?? null
}
export type SourceRow = NonNullable<Awaited<ReturnType<typeof getProjectSource>>>

export interface SourceDto {
  kind: 'zip' | 'github'
  apiUrl: string
  repository: string | null
  refType: 'branch' | 'tag' | 'commit' | null
  ref: string | null
  subdirectory: string | null
  composePath: string
  submodules: boolean
  hasToken: boolean
  allowedApiUrls: string[]
}

export function toSourceDto(s: SourceRow | null): SourceDto {
  return {
    kind: s?.kind ?? 'zip',
    apiUrl: s?.apiUrl ?? allowedGithubApis()[0] ?? 'https://api.github.com',
    repository: s?.repository ?? null,
    refType: s?.refType ?? null,
    ref: s?.ref ?? null,
    subdirectory: s?.subdirectory ?? null,
    composePath: s?.composePath ?? 'compose.yml',
    submodules: s?.submodules ?? false,
    hasToken: !!s?.tokenSecretId,
    allowedApiUrls: allowedGithubApis(),
  }
}

export interface SourceInput {
  kind: 'zip' | 'github'
  apiUrl: string
  repository: string | null
  refType: 'branch' | 'tag' | 'commit' | null
  ref: string | null
  subdirectory: string | null
  composePath: string
  submodules: boolean
  /** undefined : inchangé ; null : supprimé ; chaîne : remplacé. */
  token?: string | null
}

export async function saveProjectSource(projectId: string, input: SourceInput): Promise<void> {
  if (input.kind === 'github') {
    if (!allowedGithubApis().includes(normalizeApiUrl(input.apiUrl))) throw createError({ statusCode: 422, statusMessage: 'API GitHub non autorisée', data: { errors: { apiUrl: 'API non autorisée par l\'administrateur' } } })
  }
  const existing = await getProjectSource(projectId)
  await db().transaction(async (tx) => {
    let tokenSecretId = existing?.tokenSecretId ?? null
    if (input.token === null && tokenSecretId) {
      await tx.update(schema.projectSources).set({ tokenSecretId: null }).where(eq(schema.projectSources.projectId, projectId))
      await tx.delete(schema.secrets).where(eq(schema.secrets.id, tokenSecretId))
      tokenSecretId = null
    }
    else if (typeof input.token === 'string') {
      const { envelope, keyId } = encryptSecret(input.token)
      if (tokenSecretId) await tx.update(schema.secrets).set({ envelope, keyId, rotatedAt: new Date() }).where(eq(schema.secrets.id, tokenSecretId))
      else tokenSecretId = (await tx.insert(schema.secrets).values({ purpose: 'github_token', envelope, keyId }).returning({ id: schema.secrets.id }))[0]!.id
    }
    const values = {
      kind: input.kind,
      apiUrl: normalizeApiUrl(input.apiUrl),
      repository: input.repository,
      refType: input.refType,
      ref: input.ref,
      subdirectory: input.subdirectory,
      composePath: input.composePath,
      submodules: input.submodules,
      tokenSecretId,
    }
    if (existing) await tx.update(schema.projectSources).set(values).where(eq(schema.projectSources.projectId, projectId))
    else await tx.insert(schema.projectSources).values({ ...values, projectId })
  })
}

export async function githubCredentials(s: SourceRow): Promise<GithubSource> {
  if (s.kind !== 'github' || !s.repository) throw createError({ statusCode: 422, statusMessage: 'Le projet n\'a pas de source GitHub' })
  let token: string | null = null
  if (s.tokenSecretId) {
    const [sec] = await db().select({ envelope: schema.secrets.envelope }).from(schema.secrets).where(eq(schema.secrets.id, s.tokenSecretId))
    if (sec) token = decryptSecret(sec.envelope)
  }
  return { apiUrl: s.apiUrl, repository: s.repository, token }
}

/** Chemin du Compose dans le dépôt (sous-répertoire du projet inclus). */
export function repoComposePath(s: Pick<SourceRow, 'subdirectory' | 'composePath'>): string {
  return validateRelativeEntry([s.subdirectory, s.composePath].filter(Boolean).join('/'))
}

export function githubErrorToHttp(err: unknown): never {
  if (err instanceof GithubError) {
    throw createError({ statusCode: err.kind === 'not_found' ? 404 : err.kind === 'auth' || err.kind === 'sso' ? 403 : err.kind === 'rate_limit' ? 429 : 422, statusMessage: err.message })
  }
  throw err
}

export interface SubmoduleInfo { path: string, repository: string | null, sha: string, supported: boolean }

export interface GithubPreview {
  commit: ResolvedCommit
  repository: string
  refType: 'branch' | 'tag' | 'commit'
  ref: string
  composePath: string
  composeFiles: string[]
  treeTruncated: boolean
  submodules: SubmoduleInfo[]
  analysis: AnalysisResult
}

export async function previewGithub(t: TargetRow, opts: { refType?: 'branch' | 'tag' | 'commit', ref?: string, commitSha?: string, approvals: PortApproval[], releaseSlug: string, exposures?: Exposure[], progress?: Progress }): Promise<GithubPreview & { composeText: string, files: Set<string>, envFileKeys: Record<string, string[]> }> {
  const progress = opts.progress ?? noProgress
  const s = await getProjectSource(t.project.id)
  if (!s || s.kind !== 'github') throw createError({ statusCode: 422, statusMessage: 'Configurer d\'abord la source GitHub du projet' })
  const src = await githubCredentials(s)
  const refType = opts.refType ?? s.refType ?? 'branch'
  const ref = opts.ref ?? s.ref ?? ''
  if (!ref && !opts.commitSha) throw createError({ statusCode: 422, statusMessage: 'Branche, tag ou commit à préciser' })
  try {
    const gh = github()
    await progress.step(`Résolution de ${opts.commitSha ? `du commit ${opts.commitSha.slice(0, 7)}` : `${refType === 'branch' ? 'la branche' : refType === 'tag' ? 'du tag' : 'du commit'} ${ref}`} sur GitHub`, 1, 4)
    const commit = await gh.resolve(src, opts.commitSha ? 'commit' : refType, opts.commitSha ?? ref)
    await progress.step(`Lecture de l'arborescence du commit ${commit.sha.slice(0, 7)}`, 2, 4)
    const tree = await gh.tree(src, commit.sha)
    const files = new Set(tree.entries.filter(e => e.type === 'blob').map(e => e.path))
    const submodules: SubmoduleInfo[] = []
    const gitlinks = tree.entries.filter(e => e.type === 'commit')
    if (gitlinks.length) {
      const declared = files.has('.gitmodules') ? parseGitmodules(await gh.file(src, commit.sha, '.gitmodules', 64 * 1024), src.apiUrl) : []
      for (const g of gitlinks) {
        const d = declared.find(x => x.path === g.path)
        submodules.push({ path: g.path, repository: d?.repository ?? null, sha: g.sha, supported: !!d?.repository })
      }
      if (s.submodules) {
        // Arbres des sous-modules lus en parallèle (appels indépendants à l'API GitHub).
        const supported = submodules.filter(x => x.supported && x.sha)
        if (supported.length) await progress.step(`Lecture de ${supported.length === 1 ? 'du sous-module' : 'des sous-modules'} ${supported.map(x => x.path).join(', ')}`, 2, 4)
        const trees = await mapLimit(supported, 4, sm => gh.tree({ ...src, repository: sm.repository! }, sm.sha))
        for (const [i, sub] of trees.entries()) for (const e of sub.entries) if (e.type === 'blob') files.add(`${supported[i]!.path}/${e.path}`)
      }
    }
    const composePath = repoComposePath(s)
    await progress.step(`Lecture de ${composePath} et analyse (sécurité, ports, volumes, réseaux)`, 3, 4)
    const composeText = await gh.file(src, commit.sha, composePath, MAX_COMPOSE_READ)
    const env = await collectEnvFiles(composeText, composePath, files, p => gh.file(src, commit.sha, p, MAX_ENV_FILE))
    const prefix = s.subdirectory ? `${validateRelativeEntry(s.subdirectory)}/` : ''
    const composeFiles = [...files].filter(f => f.startsWith(prefix) && isComposeFile(f)).sort()
    const analysis = await analyzeForTarget(t, { composeText, composePath, files, releaseSlug: opts.releaseSlug, portApprovals: opts.approvals, exposures: opts.exposures, sourceKind: 'github', envFileKeys: env.keys })
    analysis.issues.push(...await imageSourceIssues(analysis.images, analysis.builds.map(b => b.service)))
    if (tree.truncated) analysis.issues.push({ severity: 'warning', code: 'github.tree_truncated', message: 'Dépôt très volumineux : la liste des fichiers est incomplète, la présence des Dockerfiles n\'a pu être vérifiée qu\'en partie' })
    if (s.submodules) {
      for (const sm of submodules.filter(x => !x.supported)) {
        analysis.issues.push({ severity: 'error', code: 'github.submodule', message: `Sous-module ${sm.path} hors de cette instance GitHub : non supporté` })
        analysis.ok = false
      }
    }
    else if (submodules.length) {
      analysis.issues.push({ severity: 'info', code: 'github.submodules_ignored', message: `${submodules.length} sous-module(s) ignoré(s) (option désactivée) : ${submodules.map(x => x.path).join(', ')}` })
    }
    return { commit, repository: src.repository, refType, ref: opts.commitSha ?? ref, composePath, composeFiles, treeTruncated: tree.truncated, submodules, analysis, composeText, files, envFileKeys: env.keys }
  }
  catch (err) {
    githubErrorToHttp(err)
  }
}

/** Télécharge l'archive d'un commit (et de ses sous-modules) dans le stockage des archives. */
export async function downloadGithubArchives(s: SourceRow, sha: string, submodules: SubmoduleInfo[], log: (m: string) => Promise<void>): Promise<{ main: StoredUpload, subs: { path: string, upload: StoredUpload }[] }> {
  const src = await githubCredentials(s)
  const gh = github()
  await log(`Téléchargement de ${src.repository}@${sha.slice(0, 12)} depuis GitHub`)
  // Étape intermédiaire du stockage (taille reçue, contrôle de sécurité) reprise dans les logs du déploiement.
  const checks = { step: async (label: string, current?: number) => { if (current === 2) await log(label) } }
  const t0 = Date.now()
  const took = () => `${Math.round((Date.now() - t0) / 100) / 10} s`
  // Archive principale et sous-modules téléchargés ensemble (appels indépendants).
  const subModules = s.submodules ? submodules.filter(x => x.supported && x.sha) : []
  const [main, ...subUploads] = await mapLimit([null, ...subModules], 3, async (sm) => {
    if (!sm) {
      const up = await storeUpload(await gh.zipball(src, sha), `${src.repository.replace('/', '-')}-${sha.slice(0, 12)}.zip`, null, checks)
      await log(`Archive GitHub reçue et inspectée : ${up.report.files} fichiers, ${formatBytes(up.sizeBytes)} en ${took()} (dossier racine ${up.report.rootFolder ?? 'aucun'})`)
      return up
    }
    const up = await storeUpload(await gh.zipball({ ...src, repository: sm.repository! }, sm.sha), `${sm.repository!.replace('/', '-')}-${sm.sha.slice(0, 12)}.zip`, null)
    await log(`Sous-module ${sm.path} (${sm.repository}@${sm.sha.slice(0, 12)}) : ${up.report.files} fichiers, ${formatBytes(up.sizeBytes)} en ${took()}`)
    return up
  })
  return { main: main!, subs: subModules.map((sm, i) => ({ path: sm.path, upload: subUploads[i]! })) }
}

