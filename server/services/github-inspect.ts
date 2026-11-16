/**
 * Inspection d'un dépôt GitHub à partir d'une simple URL, pour l'assistant de
 * déploiement : accès (jeton nécessaire ou non), référence résolue, fichiers
 * Compose trouvés, questions restant à poser. Rien n'est enregistré ; le jeton
 * éventuel n'est utilisé que pour cet appel (ou repris de la source du projet).
 */
import { createError } from 'h3'
import { parseRepoUrl } from '../../shared/utils/github-url'
import { type GithubSource, GithubError, accessAdvice, normalizeApiUrl, tokenKind } from '../lib/github'
import { isComposeFile } from '../lib/zip'
import { allowedGithubApis, getProjectSource, github, githubCredentials } from './sources'

export interface InspectInput { url: string, token?: string | null, refType?: 'branch' | 'tag' | 'commit' | null, ref?: string | null }

export interface InspectResult {
  /** Accès impossible sans jeton (dépôt privé ou inexistant) : l'assistant le demande. */
  needsToken: boolean
  message: string | null
  apiUrl: string
  repository: string
  auth: 'token' | 'stored' | 'none'
  repo: { fullName: string, visibility: string, defaultBranch: string, htmlUrl: string, archived: boolean } | null
  refType: 'branch' | 'tag' | 'commit' | null
  ref: string | null
  commit: { sha: string, message: string, author: string | null, date: string | null } | null
  /** Dossier du projet dans le dépôt (désigné par l'URL), sinon la racine. */
  subdirectory: string | null
  /** Fichiers Compose (chemins depuis la racine du dépôt). */
  composeFiles: string[]
  suggestedCompose: string | null
  submodules: string[]
  truncated: boolean
  advice: { level: 'info' | 'warning', message: string }[]
}

const PREFERRED = ['compose.yaml', 'compose.yml', 'docker-compose.yaml', 'docker-compose.yml']

export async function inspectRepository(projectId: string, input: InspectInput): Promise<InspectResult> {
  const parsed = parseRepoUrl(input.url)
  if (!parsed) throw createError({ statusCode: 422, statusMessage: 'URL de dépôt GitHub non reconnue', data: { errors: { url: 'Ex. https://github.com/organisation/depot' } } })
  const apiUrl = normalizeApiUrl(parsed.apiUrl)
  if (!allowedGithubApis().includes(apiUrl)) throw createError({ statusCode: 422, statusMessage: `Instance GitHub non autorisée : ${apiUrl}`, data: { errors: { url: 'Instance GitHub non autorisée par l\'administrateur' } } })

  // Jeton : celui saisi, sinon celui déjà enregistré pour ce même dépôt.
  let token: string | null = input.token ?? null
  let auth: InspectResult['auth'] = token ? 'token' : 'none'
  if (!token) {
    const s = await getProjectSource(projectId)
    if (s?.kind === 'github' && s.repository?.toLowerCase() === parsed.repository.toLowerCase() && s.tokenSecretId && normalizeApiUrl(s.apiUrl) === apiUrl) {
      token = (await githubCredentials(s)).token
      auth = token ? 'stored' : 'none'
    }
  }
  const src: GithubSource = { apiUrl, repository: parsed.repository, token }
  const gh = github()
  const empty = { apiUrl, repository: parsed.repository, auth, repo: null, refType: null, ref: null, commit: null, subdirectory: null, composeFiles: [], suggestedCompose: null, submodules: [], truncated: false, advice: [] }

  let repo
  try {
    repo = await gh.repository(src)
  }
  catch (err) {
    if (err instanceof GithubError && (err.kind === 'not_found' || err.kind === 'auth' || err.kind === 'sso' || err.kind === 'rate_limit')) {
      return { ...empty, needsToken: !token || err.kind !== 'not_found', message: err.message }
    }
    throw err instanceof GithubError ? createError({ statusCode: 422, statusMessage: err.message }) : err
  }

  // Référence : celle demandée, sinon celle de l'URL (branche, puis tag, puis commit), sinon la branche par défaut.
  const candidates: { refType: 'branch' | 'tag' | 'commit', ref: string }[] = []
  // URL de release : son tag (« latest » : celui de la dernière release stable).
  let releaseTag = parsed.release?.tag ?? null
  if (parsed.release && !releaseTag && !(input.refType && input.ref)) releaseTag = await gh.release(src, null).then(r => r.tag).catch(() => null)
  if (input.refType && input.ref) candidates.push({ refType: input.refType, ref: input.ref })
  else if (releaseTag) candidates.push({ refType: 'tag', ref: releaseTag })
  else if (parsed.ref) candidates.push({ refType: 'branch', ref: parsed.ref }, { refType: 'tag', ref: parsed.ref }, ...(/^[0-9a-f]{7,40}$/i.test(parsed.ref) ? [{ refType: 'commit' as const, ref: parsed.ref }] : []))
  candidates.push({ refType: 'branch', ref: repo.defaultBranch })
  let chosen: { refType: 'branch' | 'tag' | 'commit', ref: string } | null = null
  let commit = null
  let refError: string | null = null
  for (const c of candidates) {
    try {
      commit = await gh.resolve(src, c.refType, c.ref)
      chosen = c
      break
    }
    catch (err) {
      refError ??= err instanceof GithubError ? err.message : String(err)
    }
  }
  const base = {
    ...empty, needsToken: false,
    repo: { fullName: repo.fullName, visibility: repo.visibility, defaultBranch: repo.defaultBranch, htmlUrl: repo.htmlUrl, archived: repo.archived },
    advice: accessAdvice(repo.visibility, tokenKind(token), repo.scopes),
  }
  if (!chosen || !commit) return { ...base, message: `Référence introuvable : ${refError ?? 'inconnue'}` }

  const tree = await gh.tree(src, commit.sha)
  const blobs = tree.entries.filter(e => e.type === 'blob').map(e => e.path)
  // Dossier désigné par l'URL : celui d'un fichier Compose (blob) ou le dossier (tree).
  let subdirectory: string | null = null
  let suggested: string | null = null
  if (parsed.path && parsed.pathKind === 'file' && blobs.includes(parsed.path) && isComposeFile(parsed.path)) suggested = parsed.path
  if (parsed.path && parsed.pathKind === 'dir' && tree.entries.some(e => e.type === 'tree' && e.path === parsed.path)) subdirectory = parsed.path
  const scope = subdirectory ? `${subdirectory}/` : ''
  const composeFiles = blobs.filter(p => p.startsWith(scope) && isComposeFile(p)).sort((a, b) => a.split('/').length - b.split('/').length || a.localeCompare(b))
  if (!suggested) {
    const top = composeFiles.filter(p => !p.slice(scope.length).includes('/'))
    suggested = PREFERRED.map(n => `${scope}${n}`).find(p => top.includes(p)) ?? (composeFiles.length === 1 ? composeFiles[0]! : null)
  }
  const advice = [...base.advice]
  if (repo.archived) advice.push({ level: 'info', message: 'Dépôt archivé (lecture seule) sur GitHub.' })
  return {
    ...base,
    message: chosen.ref !== (input.ref ?? parsed.ref ?? repo.defaultBranch) ? `Référence « ${input.ref ?? parsed.ref} » introuvable : branche par défaut ${repo.defaultBranch} retenue` : null,
    refType: chosen.refType,
    ref: chosen.ref,
    commit: { sha: commit.sha, message: commit.message, author: commit.author ?? null, date: commit.date ?? null },
    subdirectory,
    composeFiles,
    suggestedCompose: suggested,
    submodules: tree.entries.filter(e => e.type === 'commit').map(e => e.path),
    truncated: tree.truncated,
    advice,
  }
}
