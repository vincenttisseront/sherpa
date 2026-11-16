/**
 * Client GitHub (API REST v3, github.com ou GitHub Enterprise) pour les
 * sources de projet (§7.1).
 *
 * Sécurité :
 * - seules les API listées par l'administrateur sont joignables (pas de SSRF
 *   via une URL saisie par un utilisateur) ;
 * - les redirections (téléchargement d'archive) ne sont suivies que vers des
 *   hôtes autorisés, et sans réémettre le token ;
 * - le token n'apparaît dans aucun message d'erreur.
 * Toute référence (branche, tag, commit) est résolue en SHA de commit complet :
 * c'est ce SHA qui est déployé et enregistré.
 */
import { createHash } from 'node:crypto'
import { Readable } from 'node:stream'
import { Agent, fetch } from 'undici'
import { redactPatterns } from '../utils/redact'

export interface GithubSource {
  apiUrl: string
  repository: string
  token: string | null
}

export interface ResolvedCommit {
  sha: string
  message: string
  author: string | null
  date: string | null
  htmlUrl: string | null
}

export interface TreeEntry { path: string, type: 'blob' | 'tree' | 'commit', sha: string, size?: number }

export class GithubError extends Error {
  constructor(message: string, public readonly status: number | null, public readonly kind: 'not_found' | 'auth' | 'sso' | 'rate_limit' | 'forbidden_host' | 'invalid' | 'network' | 'http') {
    super(message)
    this.name = 'GithubError'
  }
}

export const REPOSITORY_RE = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})\/[A-Za-z0-9._-]{1,100}$/
const SHA_RE = /^[0-9a-f]{7,40}$/i
const REF_RE = /^(?!.*\.\.)(?!.*\/\/)(?!\/)(?!.*\/$)[A-Za-z0-9._/-]{1,250}$/

export interface GithubClientOptions {
  /** API autorisées, ex. https://api.github.com, https://ghe.interne/api/v3 */
  allowedApiUrls: readonly string[]
  timeoutMs?: number
  /** Développement : autoriser http:// (refusé en production par la configuration). */
  allowHttp?: boolean
}

/** Hôtes vers lesquels une redirection de téléchargement peut mener pour une API donnée. */
export function downloadHostsFor(apiUrl: string): string[] {
  const u = new URL(apiUrl)
  // Archives de code (codeload) et fichiers attachés aux releases (stockage objet GitHub).
  if (u.hostname === 'api.github.com') return ['api.github.com', 'codeload.github.com', 'objects.githubusercontent.com', 'release-assets.githubusercontent.com', 'github-releases.githubusercontent.com']
  // GitHub Enterprise : API et archives sur le même hôte.
  return [u.host]
}

export function normalizeApiUrl(raw: string): string {
  return raw.trim().replace(/\/+$/, '')
}

export function createGithubClient(opts: GithubClientOptions) {
  const allowed = new Set(opts.allowedApiUrls.map(normalizeApiUrl))
  const timeout = opts.timeoutMs ?? 20_000
  const dispatcher = new Agent({ connect: { rejectUnauthorized: true } })

  function checkSource(src: GithubSource) {
    const api = normalizeApiUrl(src.apiUrl)
    if (!allowed.has(api)) throw new GithubError(`API GitHub non autorisée : ${api}`, null, 'forbidden_host')
    const u = new URL(api)
    if (u.protocol !== 'https:' && !(opts.allowHttp && u.protocol === 'http:')) throw new GithubError('HTTPS obligatoire pour l\'API GitHub', null, 'forbidden_host')
    if (!REPOSITORY_RE.test(src.repository)) throw new GithubError('Dépôt invalide : format attendu « organisation/depot »', null, 'invalid')
    return api
  }

  function headers(src: GithubSource, accept = 'application/vnd.github+json'): Record<string, string> {
    return {
      'accept': accept,
      'x-github-api-version': '2022-11-28',
      'user-agent': 'sherpa',
      ...(src.token ? { authorization: `Bearer ${src.token}` } : {}),
    }
  }

  async function request(src: GithubSource, path: string, accept?: string, init?: { method: 'POST' | 'PUT' | 'PATCH', body: unknown }) {
    const api = checkSource(src)
    let res
    try {
      res = await fetch(`${api}${path}`, {
        method: init?.method ?? 'GET',
        headers: { ...headers(src, accept), ...(init ? { 'content-type': 'application/json' } : {}) },
        body: init ? JSON.stringify(init.body) : undefined,
        dispatcher,
        redirect: 'manual',
        signal: AbortSignal.timeout(timeout),
      })
    }
    catch (err) {
      const e = err as { name?: string, cause?: { code?: string }, message?: string }
      throw new GithubError(e.name === 'TimeoutError' ? 'GitHub ne répond pas (délai dépassé)' : `GitHub injoignable : ${e.cause?.code ?? e.message}`, null, 'network')
    }
    if (res.status === 401) throw new GithubError('Token GitHub refusé ou expiré (y compris pour un dépôt public : un token invalide n\'est jamais ignoré)', 401, 'auth')
    if (res.status === 403 || res.status === 429) {
      // Organisation protégée par SAML SSO : le token doit être autorisé pour elle.
      const sso = res.headers.get('x-github-sso')
      if (sso) {
        const url = /url=(\S+)/.exec(sso)?.[1]
        throw new GithubError(`Token non autorisé pour l'organisation (SAML SSO) : l'autoriser dans GitHub (Settings → Tokens → Configure SSO)${url ? ` — ${url}` : ''}`, 403, 'sso')
      }
      const remaining = res.headers.get('x-ratelimit-remaining')
      if (remaining === '0' || res.status === 429) {
        const reset = Number(res.headers.get('x-ratelimit-reset') ?? 0)
        const when = reset ? ` (réinitialisation à ${new Date(reset * 1000).toLocaleTimeString('fr-FR', { timeZone: 'Europe/Paris' })})` : ''
        throw new GithubError(src.token
          ? `Limite d'appels GitHub du token atteinte${when}`
          : `Limite d'appels GitHub sans token atteinte (60 par heure et par adresse)${when} : ajouter un token, même pour un dépôt public`, res.status, 'rate_limit')
      }
      throw new GithubError('Accès refusé par GitHub : vérifier les droits du token sur ce dépôt', 403, 'auth')
    }
    if (res.status === 404) {
      throw new GithubError(src.token
        ? 'Introuvable sur GitHub : nom du dépôt ou référence inexistants, ou token sans accès à ce dépôt'
        : 'Introuvable sur GitHub : nom inexistant, ou dépôt privé (un token est alors nécessaire)', 404, 'not_found')
    }
    return res
  }

  async function json<T>(src: GithubSource, path: string, init?: { method: 'POST' | 'PUT' | 'PATCH', body: unknown }): Promise<T> {
    const res = await request(src, path, undefined, init)
    if (!res.ok) {
      const text = await res.text()
      // Erreur de validation de GitHub (422) : son message, plus parlant que le statut.
      const detail = (() => {
        try {
          const j = JSON.parse(text) as { message?: string, errors?: { message?: string, code?: string, field?: string }[] }
          return [j.message, ...(j.errors ?? []).map(e => e.message ?? [e.field, e.code].filter(Boolean).join(' '))].filter(Boolean).join(' — ')
        }
        catch {
          return text
        }
      })()
      throw new GithubError(`GitHub a répondu ${res.status} : ${redactPatterns(detail.slice(0, 300))}`, res.status, 'http')
    }
    return await res.json() as T
  }

  const repo = (src: GithubSource) => `/repos/${src.repository}`
  const packagesBase = (owner: { login: string, type: 'org' | 'user' | 'self' }) => (owner.type === 'self' ? '/user/packages' : `/${owner.type === 'org' ? 'orgs' : 'users'}/${owner.login}/packages`)

  async function readFile(src: GithubSource, sha: string, path: string, maxBytes: number): Promise<string> {
    const res = await request(src, `${repo(src)}/contents/${path.split('/').map(encodeURIComponent).join('/')}?ref=${sha}`, 'application/vnd.github.raw+json')
    if (!res.ok) throw new GithubError(`Lecture de ${path} impossible (${res.status})`, res.status, 'http')
    const len = Number(res.headers.get('content-length') ?? 0)
    if (len > maxBytes) throw new GithubError(`${path} trop volumineux`, null, 'invalid')
    const text = await res.text()
    if (Buffer.byteLength(text) > maxBytes) throw new GithubError(`${path} trop volumineux`, null, 'invalid')
    return text
  }

  // Contenu d'un commit immuable : arborescence, fichiers et détail d'un SHA complet mis en cache
  // (15 min, 300 entrées). Clé liée au jeton : un contenu privé n'est jamais resservi sans lui.
  const memo = new Map<string, { at: number, value: Promise<unknown> }>()
  const MEMO_TTL = 15 * 60_000
  const memoKey = (src: GithubSource, ...parts: string[]) => [normalizeApiUrl(src.apiUrl), src.repository.toLowerCase(), createHash('sha256').update(src.token ?? '').digest('hex').slice(0, 16), ...parts].join('|')
  function cached<T>(key: string, load: () => Promise<T>): Promise<T> {
    const hit = memo.get(key)
    if (hit && Date.now() - hit.at < MEMO_TTL) return hit.value as Promise<T>
    if (memo.size >= 300) memo.delete(memo.keys().next().value!)
    const value = load()
    memo.set(key, { at: Date.now(), value })
    value.catch(() => memo.delete(key))
    return value
  }

  return {
    async repository(src: GithubSource) {
      const res = await request(src, repo(src))
      if (!res.ok) throw new GithubError(`GitHub a répondu ${res.status}`, res.status, 'http')
      const r = await res.json() as { full_name: string, private: boolean, visibility?: string, default_branch: string, html_url: string, archived?: boolean }
      // Jetons classiques : périmètre annoncé par GitHub (absent pour les jetons fine-grained et d'application).
      const scopes = res.headers.get('x-oauth-scopes')
      return {
        fullName: r.full_name,
        private: r.private,
        visibility: (r.visibility ?? (r.private ? 'private' : 'public')) as 'public' | 'private' | 'internal',
        defaultBranch: r.default_branch,
        htmlUrl: r.html_url,
        archived: !!r.archived,
        scopes: scopes === null ? null : scopes.split(',').map(x => x.trim()).filter(Boolean),
      }
    },

    /** Résout branche, tag ou commit en SHA de commit complet. */
    async resolve(src: GithubSource, refType: 'branch' | 'tag' | 'commit', ref: string): Promise<ResolvedCommit> {
      let sha: string
      if (refType === 'commit') {
        if (!SHA_RE.test(ref)) throw new GithubError('SHA de commit invalide (7 à 40 caractères hexadécimaux)', null, 'invalid')
        sha = ref
      }
      else {
        if (!REF_RE.test(ref)) throw new GithubError('Nom de référence invalide', null, 'invalid')
        const kind = refType === 'branch' ? 'heads' : 'tags'
        const r = await json<{ object: { sha: string, type: string } }>(src, `${repo(src)}/git/ref/${kind}/${ref.split('/').map(encodeURIComponent).join('/')}`)
        sha = r.object.sha
        // Tag annoté : objet tag → commit.
        if (r.object.type === 'tag') sha = (await json<{ object: { sha: string } }>(src, `${repo(src)}/git/tags/${sha}`)).object.sha
      }
      const load = () => json<{ sha: string, html_url: string, commit: { message: string, author: { name: string, date: string } | null } }>(src, `${repo(src)}/commits/${sha}`)
      const c = /^[0-9a-f]{40}$/i.test(sha) ? await cached(memoKey(src, 'commit', sha.toLowerCase()), load) : await load()
      return { sha: c.sha, message: c.commit.message.split('\n')[0]!.slice(0, 200), author: c.commit.author?.name ?? null, date: c.commit.author?.date ?? null, htmlUrl: c.html_url }
    },

    /** Arborescence complète du commit (fichiers, répertoires, sous-modules). */
    async tree(src: GithubSource, sha: string): Promise<{ entries: TreeEntry[], truncated: boolean }> {
      const r = await cached(memoKey(src, 'tree', sha), () => json<{ tree: { path: string, type: string, sha: string, size?: number }[], truncated: boolean }>(src, `${repo(src)}/git/trees/${sha}?recursive=1`))
      return { entries: r.tree.filter(e => e.type === 'blob' || e.type === 'tree' || e.type === 'commit').map(e => ({ path: e.path, type: e.type as TreeEntry['type'], sha: e.sha, size: e.size })), truncated: r.truncated }
    },

    /** Contenu brut d'un fichier au commit donné (taille bornée). */
    async file(src: GithubSource, sha: string, path: string, maxBytes: number): Promise<string> {
      return /^[0-9a-f]{40}$/i.test(sha) ? cached(memoKey(src, 'file', sha, path, String(maxBytes)), () => readFile(src, sha, path, maxBytes)) : readFile(src, sha, path, maxBytes)
    },

    /**
     * Archive ZIP du commit, en flux. La redirection vers l'hôte de
     * téléchargement est vérifiée, et le token n'y est pas renvoyé.
     */
    async zipball(src: GithubSource, sha: string): Promise<Readable> {
      if (!/^[0-9a-f]{40}$/i.test(sha)) throw new GithubError('SHA complet requis pour le téléchargement', null, 'invalid')
      return download(src, `${repo(src)}/zipball/${sha}`)
    },

    /** Releases publiées (hors brouillons), les plus récentes d'abord, avec leurs fichiers attachés. */
    async releases(src: GithubSource, limit = 20): Promise<GithubRelease[]> {
      const r = await json<RawRelease[]>(src, `${repo(src)}/releases?per_page=${Math.min(100, Math.max(1, limit))}`)
      return r.filter(x => !x.draft).map(toRelease)
    },

    /** Release d'un tag, ou la dernière release stable (tag null). */
    async release(src: GithubSource, tag: string | null): Promise<GithubRelease> {
      if (tag !== null && !REF_RE.test(tag)) throw new GithubError('Nom de tag invalide', null, 'invalid')
      return toRelease(await json<RawRelease>(src, tag === null ? `${repo(src)}/releases/latest` : `${repo(src)}/releases/tags/${tag.split('/').map(encodeURIComponent).join('/')}`))
    },

    /** Fichier attaché à une release (archive), en flux. */
    async releaseAsset(src: GithubSource, assetId: number): Promise<Readable> {
      if (!Number.isInteger(assetId) || assetId <= 0) throw new GithubError('Fichier de release invalide', null, 'invalid')
      return download(src, `${repo(src)}/releases/assets/${assetId}`, 'application/octet-stream')
    },

    // --- Statut de déploiement (API Deployments) : « déployé en staging » visible sur le commit et les PR ---

    /** Crée un déploiement GitHub pour un commit ou un tag (aucun contrôle de statut requis, pas de fusion automatique). */
    async createDeployment(src: GithubSource, input: { ref: string, environment: string, description: string, production: boolean }): Promise<{ id: number }> {
      if (!REF_RE.test(input.ref)) throw new GithubError('Référence invalide', null, 'invalid')
      const r = await json<{ id?: number }>(src, `${repo(src)}/deployments`, { method: 'POST', body: { ref: input.ref, environment: input.environment.slice(0, 255), description: input.description.slice(0, 140), auto_merge: false, required_contexts: [], production_environment: input.production, transient_environment: !input.production, task: 'deploy' } })
      if (typeof r.id !== 'number') throw new GithubError('GitHub n\'a pas créé le déploiement (fusion automatique ou statuts requis)', null, 'invalid')
      return { id: r.id }
    },

    /** Statut d'un déploiement GitHub : queued, in_progress, success, failure, error, inactive. */
    async createDeploymentStatus(src: GithubSource, id: number, input: { state: 'queued' | 'in_progress' | 'success' | 'failure' | 'error' | 'inactive', description: string, logUrl?: string | null, environmentUrl?: string | null }): Promise<void> {
      await json(src, `${repo(src)}/deployments/${id}/statuses`, { method: 'POST', body: { state: input.state, description: input.description.slice(0, 140), auto_inactive: true, ...(input.logUrl ? { log_url: input.logUrl } : {}), ...(input.environmentUrl ? { environment_url: input.environmentUrl } : {}) } })
    },

    // --- Demandes de correction (écriture : issues, branches, fichiers, PR) ---

    /** Ouvre une issue. */
    async createIssue(src: GithubSource, input: { title: string, body: string }): Promise<{ number: number, htmlUrl: string }> {
      const r = await json<{ number: number, html_url: string }>(src, `${repo(src)}/issues`, { method: 'POST', body: { title: input.title, body: input.body } })
      return { number: r.number, htmlUrl: r.html_url }
    },

    /** Issue ou PR (une PR est aussi une issue pour GitHub) : état. */
    async issue(src: GithubSource, number: number): Promise<{ number: number, state: 'open' | 'closed', htmlUrl: string, isPull: boolean, closedAt: string | null, title: string }> {
      const r = await json<{ number: number, state: string, html_url: string, pull_request?: unknown, closed_at: string | null, title: string }>(src, `${repo(src)}/issues/${number}`)
      return { number: r.number, state: r.state === 'closed' ? 'closed' : 'open', htmlUrl: r.html_url, isPull: !!r.pull_request, closedAt: r.closed_at, title: r.title }
    },

    /** PR : état et fusion. */
    async pull(src: GithubSource, number: number): Promise<{ number: number, state: 'open' | 'closed', merged: boolean, htmlUrl: string, closedAt: string | null }> {
      const r = await json<{ number: number, state: string, merged?: boolean, merged_at?: string | null, html_url: string, closed_at: string | null }>(src, `${repo(src)}/pulls/${number}`)
      return { number: r.number, state: r.state === 'closed' ? 'closed' : 'open', merged: !!(r.merged || r.merged_at), htmlUrl: r.html_url, closedAt: r.closed_at }
    },

    /** Dernier commit d'une branche (sans cache : une branche avance). */
    async branchHead(src: GithubSource, branch: string): Promise<string> {
      if (!REF_RE.test(branch)) throw new GithubError('Nom de branche invalide', null, 'invalid')
      return (await json<{ object: { sha: string } }>(src, `${repo(src)}/git/ref/heads/${branch.split('/').map(encodeURIComponent).join('/')}`)).object.sha
    },

    /** Fichier d'une branche ou d'un commit : contenu texte et empreinte (pour le remplacer) ; null s'il n'existe pas. */
    async fileAt(src: GithubSource, ref: string, path: string): Promise<{ sha: string, content: string } | null> {
      const res = await request(src, `${repo(src)}/contents/${path.split('/').map(encodeURIComponent).join('/')}?ref=${encodeURIComponent(ref)}`).catch((err: GithubError) => {
        if (err.kind === 'not_found') return null
        throw err
      })
      if (!res) return null
      if (!res.ok) throw new GithubError(`Lecture de ${path} impossible (${res.status})`, res.status, 'http')
      const r = await res.json() as { type?: string, sha: string, content?: string, encoding?: string }
      if (r.type && r.type !== 'file') return null
      return { sha: r.sha, content: Buffer.from(r.content ?? '', (r.encoding ?? 'base64') as BufferEncoding).toString('utf8') }
    },

    /** Nouvelle branche à partir d'un commit. */
    async createBranch(src: GithubSource, name: string, sha: string): Promise<void> {
      if (!REF_RE.test(name)) throw new GithubError('Nom de branche invalide', null, 'invalid')
      await json(src, `${repo(src)}/git/refs`, { method: 'POST', body: { ref: `refs/heads/${name}`, sha } })
    },

    /** Remplace un fichier sur une branche (un commit). */
    async putFile(src: GithubSource, input: { path: string, branch: string, message: string, content: string, sha: string | null }): Promise<void> {
      await json(src, `${repo(src)}/contents/${input.path.split('/').map(encodeURIComponent).join('/')}`, {
        method: 'PUT',
        body: { message: input.message, content: Buffer.from(input.content, 'utf8').toString('base64'), branch: input.branch, ...(input.sha ? { sha: input.sha } : {}) },
      })
    },

    /** Ouvre une PR. */
    async createPull(src: GithubSource, input: { title: string, body: string, head: string, base: string }): Promise<{ number: number, htmlUrl: string }> {
      const r = await json<{ number: number, html_url: string }>(src, `${repo(src)}/pulls`, { method: 'POST', body: input })
      return { number: r.number, htmlUrl: r.html_url }
    },

    /** Compte (organisation ou utilisateur) : type et nom affiché. */
    async owner(src: GithubSource, login: string): Promise<{ login: string, type: 'org' | 'user', name: string | null }> {
      if (!OWNER_RE.test(login)) throw new GithubError('Nom de compte invalide', null, 'invalid')
      const r = await json<{ login: string, type: string, name: string | null }>(src, `/users/${login}`)
      return { login: r.login, type: r.type === 'Organization' ? 'org' : 'user', name: r.name }
    },

    /** Packages publiés par un compte (GitHub Packages), d'un type donné. */
    /** Compte du jeton (null sans jeton ou si GitHub refuse). */
    async viewer(src: GithubSource): Promise<string | null> {
      if (!src.token) return null
      return json<{ login: string }>(src, '/user').then(r => r.login, () => null)
    },

    /** Packages publiés par un compte (GitHub Packages) ; « self » : ceux du compte du jeton, privés compris. */
    async packages(src: GithubSource, owner: { login: string, type: 'org' | 'user' | 'self' }, packageType: PackageType): Promise<GithubPackage[]> {
      if (!OWNER_RE.test(owner.login)) throw new GithubError('Nom de compte invalide', null, 'invalid')
      const out: GithubPackage[] = []
      for (let page = 1; page <= 10; page++) {
        const r = await json<RawPackage[]>(src, `${packagesBase(owner)}?package_type=${packageType}&per_page=100&page=${page}`)
        out.push(...r.map(p => ({ id: p.id, name: p.name, type: p.package_type as PackageType, visibility: p.visibility ?? null, htmlUrl: p.html_url, repository: p.repository?.full_name ?? null, versionCount: p.version_count ?? null, createdAt: p.created_at, updatedAt: p.updated_at })))
        if (r.length < 100) break
      }
      return out
    },

    /** Versions d'un package (les plus récentes d'abord), avec leurs tags pour une image de conteneur. */
    async packageVersions(src: GithubSource, owner: { login: string, type: 'org' | 'user' | 'self' }, pkg: { type: PackageType, name: string }, limit = 300): Promise<GithubPackageVersion[]> {
      const out: GithubPackageVersion[] = []
      const base = `${packagesBase(owner)}/${pkg.type}/${encodeURIComponent(pkg.name)}/versions`
      for (let page = 1; out.length < limit; page++) {
        const r = await json<RawPackageVersion[]>(src, `${base}?per_page=100&page=${page}`)
        out.push(...r.map(v => ({ id: v.id, name: v.name, tags: v.metadata?.container?.tags ?? [], createdAt: v.created_at, updatedAt: v.updated_at, htmlUrl: v.html_url ?? null })))
        if (r.length < 100) break
      }
      return out.slice(0, limit)
    },

    /** Artefacts des workflows Actions d'un dépôt (les plus récents d'abord), expirés compris. */
    async artifacts(src: GithubSource, limit = 300): Promise<GithubArtifact[]> {
      const out: GithubArtifact[] = []
      for (let page = 1; out.length < limit; page++) {
        const r = await json<{ artifacts: RawArtifact[] }>(src, `${repo(src)}/actions/artifacts?per_page=100&page=${page}`)
        out.push(...r.artifacts.map(a => ({ id: a.id, name: a.name, sizeBytes: a.size_in_bytes, expired: a.expired, createdAt: a.created_at, expiresAt: a.expires_at, branch: a.workflow_run?.head_branch ?? null, runId: a.workflow_run?.id ?? null })))
        if (r.artifacts.length < 100) break
      }
      return out.slice(0, limit)
    },

    /** Code source d'un tag au format tar.gz (comme « Source code (tar.gz) » d'une release). */
    async tarball(src: GithubSource, ref: string): Promise<Readable> {
      if (!REF_RE.test(ref)) throw new GithubError('Référence invalide', null, 'invalid')
      return download(src, `${repo(src)}/tarball/${ref.split('/').map(encodeURIComponent).join('/')}`)
    },
  }

  /**
   * Téléchargement d'une archive : l'API répond directement ou redirige vers un hôte de
   * téléchargement autorisé (URL pré-signée, sans en-tête Authorization vers un autre hôte).
   */
  async function download(src: GithubSource, path: string, accept?: string): Promise<Readable> {
    const res = await request(src, path, accept)
    let body: import('node:stream/web').ReadableStream | null
    if (res.status >= 300 && res.status < 400) {
      const location = res.headers.get('location')
      if (!location) throw new GithubError('Redirection GitHub sans destination', res.status, 'http')
      const target = new URL(location, normalizeApiUrl(src.apiUrl))
      if (!downloadHostsFor(src.apiUrl).includes(target.host)) throw new GithubError(`Redirection vers un hôte non autorisé : ${target.host}`, null, 'forbidden_host')
      if (target.protocol !== 'https:' && !(opts.allowHttp && target.protocol === 'http:')) throw new GithubError('Téléchargement non chiffré refusé', null, 'forbidden_host')
      const sameHost = target.host === new URL(normalizeApiUrl(src.apiUrl)).host
      const dl = await fetch(target, { headers: { 'user-agent': 'sherpa', ...(accept ? { accept } : {}), ...(sameHost && src.token ? { authorization: `Bearer ${src.token}` } : {}) }, dispatcher, redirect: 'manual', signal: AbortSignal.timeout(10 * 60_000) })
        .catch((err) => { throw new GithubError(`Téléchargement impossible : ${(err as Error).message}`, null, 'network') })
      if (!dl.ok) throw new GithubError(`Téléchargement de l'archive refusé (${dl.status})`, dl.status, 'http')
      body = dl.body
    }
    else if (res.ok) {
      body = res.body
    }
    else {
      throw new GithubError(`Archive indisponible (${res.status})`, res.status, 'http')
    }
    if (!body) throw new GithubError('Archive vide', null, 'http')
    return Readable.fromWeb(body)
  }
}

interface RawRelease {
  tag_name: string
  name: string | null
  draft: boolean
  prerelease: boolean
  published_at: string | null
  html_url: string
  assets: { id: number, name: string, size: number, content_type: string }[]
}

export const PACKAGE_TYPES = ['container', 'npm', 'maven', 'rubygems', 'nuget'] as const
export type PackageType = (typeof PACKAGE_TYPES)[number]
const OWNER_RE = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/

export interface GithubPackage { id: number, name: string, type: PackageType, visibility: string | null, htmlUrl: string, repository: string | null, versionCount: number | null, createdAt: string, updatedAt: string }
export interface GithubPackageVersion { id: number, name: string, tags: string[], createdAt: string, updatedAt: string, htmlUrl: string | null }
export interface GithubArtifact { id: number, name: string, sizeBytes: number, expired: boolean, createdAt: string | null, expiresAt: string | null, branch: string | null, runId: number | null }
interface RawPackage { id: number, name: string, package_type: string, visibility?: string, html_url: string, repository?: { full_name: string } | null, version_count?: number, created_at: string, updated_at: string }
interface RawPackageVersion { id: number, name: string, created_at: string, updated_at: string, html_url?: string, metadata?: { container?: { tags: string[] } } }
interface RawArtifact { id: number, name: string, size_in_bytes: number, expired: boolean, created_at: string | null, expires_at: string | null, workflow_run?: { id: number, head_branch: string | null } | null }

export interface GithubRelease {
  tag: string
  name: string | null
  prerelease: boolean
  publishedAt: string | null
  htmlUrl: string
  assets: { id: number, name: string, size: number, contentType: string }[]
}

function toRelease(r: RawRelease): GithubRelease {
  return {
    tag: r.tag_name,
    name: r.name,
    prerelease: r.prerelease,
    publishedAt: r.published_at,
    htmlUrl: r.html_url,
    assets: (r.assets ?? []).map(a => ({ id: a.id, name: a.name, size: a.size, contentType: a.content_type })),
  }
}

export type GithubClient = ReturnType<typeof createGithubClient>

export type TokenKind = 'none' | 'classic' | 'fine-grained' | 'app' | 'oauth' | 'unknown'

/** Nature du token d'après son préfixe (jamais affiché). */
export function tokenKind(token: string | null): TokenKind {
  if (!token) return 'none'
  if (token.startsWith('github_pat_')) return 'fine-grained'
  if (token.startsWith('ghp_')) return 'classic'
  if (token.startsWith('ghs_')) return 'app'
  if (token.startsWith('gho_') || token.startsWith('ghu_')) return 'oauth'
  return 'unknown'
}

const BROAD_SCOPES = ['admin:org', 'admin:repo_hook', 'admin:org_hook', 'admin:enterprise', 'delete_repo', 'write:packages', 'delete:packages', 'workflow', 'admin:public_key', 'admin:gpg_key', 'user', 'site_admin']

/**
 * Conseils sur l'accès : la plateforme ne fait que lire (contenu, références,
 * archive). Un token plus large que nécessaire est signalé.
 */
export function accessAdvice(visibility: 'public' | 'private' | 'internal', kind: TokenKind, scopes: string[] | null): { level: 'info' | 'warning', message: string }[] {
  const out: { level: 'info' | 'warning', message: string }[] = []
  if (kind === 'none') {
    out.push({ level: 'info', message: 'Dépôt public sans token : 60 appels par heure et par adresse de la plateforme. Un token en lecture seule lève cette limite.' })
    return out
  }
  if (kind === 'classic') {
    const broad = (scopes ?? []).filter(x => BROAD_SCOPES.includes(x) || x.startsWith('admin:'))
    if (broad.length) out.push({ level: 'warning', message: `Token classique trop permissif (${broad.join(', ')}) : la plateforme n'a besoin que de lire le dépôt.` })
    if (scopes?.includes('repo')) out.push({ level: visibility === 'public' ? 'warning' : 'info', message: 'Le périmètre « repo » d\'un token classique donne lecture ET écriture sur tous les dépôts privés accessibles. Préférer un token fine-grained limité à ce dépôt (Contents : lecture, Metadata : lecture).' })
  }
  if (kind === 'fine-grained' && visibility === 'public') out.push({ level: 'info', message: 'Dépôt public : le token sert uniquement à lever la limite d\'appels.' })
  return out
}

/** Sous-modules déclarés dans .gitmodules : chemin → dépôt GitHub (organisation/depot) ou null si hors GitHub. */
export function parseGitmodules(text: string, apiUrl: string): { path: string, url: string, repository: string | null }[] {
  const host = new URL(apiUrl).hostname === 'api.github.com' ? 'github.com' : new URL(apiUrl).hostname
  const out: { path: string, url: string, repository: string | null }[] = []
  let cur: { path?: string, url?: string } = {}
  const flush = () => {
    if (cur.path && cur.url) {
      const m = new RegExp(`^(?:https://${host.replace(/\./g, '\\.')}/|git@${host.replace(/\./g, '\\.')}:)([^/]+/[^/]+?)(?:\\.git)?/?$`).exec(cur.url)
      out.push({ path: cur.path, url: cur.url, repository: m && REPOSITORY_RE.test(m[1]!) ? m[1]! : null })
    }
    cur = {}
  }
  for (const line of text.split('\n')) {
    const l = line.trim()
    if (l.startsWith('[submodule')) flush()
    const kv = /^(path|url)\s*=\s*(.+)$/.exec(l)
    if (kv) cur[kv[1] as 'path' | 'url'] = kv[2]!.trim()
  }
  flush()
  return out
}
