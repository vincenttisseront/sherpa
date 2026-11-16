/**
 * Faux serveur d'API GitHub (sous-ensemble utilisé par la plateforme), pour
 * les tests et le développement hors ligne. Reproduit : refs (branches, tags
 * annotés), commits, arbre récursif (avec sous-modules), contenu brut,
 * zipball par redirection (dossier racine « org-depot-sha7/ »), 401/404.
 * Comme github.com : visibilité par dépôt (un dépôt privé est introuvable sans
 * token qui y donne accès), jetons avec périmètres (x-oauth-scopes), organisations
 * en SAML SSO (403 x-github-sso), limite d'appels anonymes, téléchargement d'un
 * dépôt privé par lien à jeton temporaire (comme codeload). Les fichiers d'un dépôt peuvent changer
 * en cours de test (nouveau commit sur la branche) ; releases publiées avec leur propre contenu.
 *
 *   npx tsx scripts/mock-github.ts <port> <org/depot> <répertoire> [token]
 */
import { createHash } from 'node:crypto'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { type Server, createServer } from 'node:http'
import { join, relative } from 'node:path'
import { makeZip } from '../server/lib/zip-writer'

export interface MockRepo {
  files: Record<string, string>
  branch?: string
  tag?: string
  /** Sous-modules : chemin → { dépôt, fichiers } (dépôt servi par le même faux serveur). */
  submodules?: Record<string, { repository: string }>
  /** Dépôt privé : accessible seulement avec un token qui y donne accès. */
  private?: boolean
  /** Releases publiées (la plus récente d'abord), chacune avec le contenu du dépôt à son tag. */
  releases?: { tag: string, name?: string, prerelease?: boolean, files: Record<string, string> }[]
  /** Artefacts des workflows Actions. */
  artifacts?: { id: number, name: string, sizeBytes: number, expired: boolean, createdAt: string, expiresAt: string, branch?: string }[]
  /** Écritures reçues (demandes de correction) : issues, PR, branches et leurs fichiers. */
  issues?: { number: number, title: string, body: string, state: 'open' | 'closed' }[]
  pulls?: { number: number, title: string, body: string, head: string, base: string, state: 'open' | 'closed', merged: boolean }[]
  branches?: Record<string, Record<string, string>>
  /** Déploiements GitHub (API Deployments) créés, avec la suite de leurs statuts. */
  deployments?: { id: number, ref: string, environment: string, description: string, production: boolean, statuses: { state: string, description: string, logUrl: string | null, environmentUrl: string | null }[] }[]
}

/** Compte (organisation ou utilisateur) et ses packages publiés. */
export interface MockOwner {
  type: 'Organization' | 'User'
  packages?: { name: string, type: string, repository?: string, versions: { id: number, name: string, tags?: string[], createdAt: string }[] }[]
}

export interface MockToken {
  /** Dépôts accessibles (privés) ; défaut : tous. */
  repos?: string[]
  /** Jeton classique : périmètres annoncés dans x-oauth-scopes. */
  scopes?: string[]
  /** Organisations SAML SSO pour lesquelles le token n'est pas autorisé. */
  ssoUnauthorized?: string[]
}

export interface MockOptions {
  /** Ancien mode : un token unique exigé partout. */
  token?: string
  tokens?: Record<string, MockToken>
  /** Nombre d'appels anonymes avant la limite (défaut : illimité). */
  anonymousLimit?: number
  /** Comptes servis par /users/{login} et leurs packages (/orgs|users/{login}/packages). */
  owners?: Record<string, MockOwner>
}

const sha1 = (s: string) => createHash('sha1').update(s).digest('hex')

export function commitOf(repo: MockRepo): string {
  return sha1(JSON.stringify(Object.entries(repo.files).sort()))
}

export function createMockGithub(repos: Record<string, MockRepo>, opts: MockOptions = {}): Server {
  let anonymousCalls = 0
  // Commit calculé à chaque requête : modifier les fichiers d'un dépôt fait avancer sa branche.
  const shaOf = (name: string) => (repos[name] ? commitOf(repos[name]) : null)
  const json = (res: import('node:http').ServerResponse, status: number, body: unknown) => {
    res.writeHead(status, { 'content-type': 'application/json' })
    res.end(JSON.stringify(body))
  }
  // Corps JSON des écritures (POST, PUT), lu avant le traitement.
  return createServer((req, res) => {
    if (req.method === 'GET' || req.method === 'HEAD') return handle(req, res, null)
    let data = ''
    req.on('data', (c) => { data += c })
    req.on('end', () => {
      let body: Record<string, unknown> | null
      try {
        body = data ? JSON.parse(data) as Record<string, unknown> : null
      }
      catch {
        return json(res, 400, { message: 'Problems parsing JSON' })
      }
      handle(req, res, body)
    })
  })

  function handle(req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse, input: Record<string, unknown> | null) {
    const url = new URL(req.url ?? '/', 'http://x')
    const isDownload = url.pathname.startsWith('/_download/')
    if (opts.token && !isDownload && req.headers.authorization !== `Bearer ${opts.token}`) return json(res, 401, { message: 'Bad credentials' })
    const bearer = /^Bearer (.+)$/.exec(req.headers.authorization ?? '')?.[1]
    const tok = bearer && opts.tokens ? opts.tokens[bearer] : undefined
    if (bearer && opts.tokens && !tok) return json(res, 401, { message: 'Bad credentials' })
    if (!bearer && !isDownload && opts.anonymousLimit !== undefined && ++anonymousCalls > opts.anonymousLimit) {
      res.writeHead(403, { 'content-type': 'application/json', 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': String(Math.floor(Date.now() / 1000) + 3600) })
      return res.end(JSON.stringify({ message: 'API rate limit exceeded' }))
    }
    // Comptes et packages (GitHub Packages).
    const acct = /^\/(users|orgs)\/([^/]+)(\/packages(?:\/([^/]+)\/([^/]+)(\/versions)?)?)?$/.exec(url.pathname)
    if (acct) {
      const o = opts.owners?.[acct[2]!]
      if (!o || (acct[1] === 'orgs' && o.type !== 'Organization')) return json(res, 404, { message: 'Not Found' })
      if (!acct[3]) return json(res, 200, { login: acct[2], type: o.type, name: null })
      const pkgs = o.packages ?? []
      if (!acct[4]) {
        const page = Number(url.searchParams.get('page') ?? 1)
        const list = page > 1 ? [] : pkgs.filter(p => p.type === url.searchParams.get('package_type'))
        return json(res, 200, list.map((p, i) => ({ id: i + 1, name: p.name, package_type: p.type, visibility: 'private', html_url: `https://github.example/${acct[2]}/packages/${p.type}/${p.name}`, repository: p.repository ? { full_name: p.repository } : null, version_count: p.versions.length, created_at: '2026-01-01T00:00:00Z', updated_at: '2026-10-01T00:00:00Z' })))
      }
      const p = pkgs.find(x => x.type === acct[4] && x.name === decodeURIComponent(acct[5]!))
      if (!p || !acct[6]) return json(res, 404, { message: 'Not Found' })
      if (Number(url.searchParams.get('page') ?? 1) > 1) return json(res, 200, [])
      return json(res, 200, p.versions.map(v => ({ id: v.id, name: v.name, created_at: v.createdAt, updated_at: v.createdAt, metadata: { package_type: p.type, container: { tags: v.tags ?? [] } } })))
    }
    const m = /^\/repos\/([^/]+\/[^/]+)(\/.*)?$/.exec(url.pathname)
    const dl = /^\/_download\/([^/]+\/[^/]+)\/([0-9a-f]{40})$/.exec(url.pathname)
    const name = (m?.[1] ?? dl?.[1])!
    const repo = repos[name]
    if (!repo) return json(res, 404, { message: 'Not Found' })
    const sha = commitOf(repo)
    // Contenus connus : branche (dernier commit) et releases (commit de leur tag).
    const versions = new Map<string, Record<string, string>>([[sha, repo.files], ...(repo.releases ?? []).map(r => [commitOf({ files: r.files }), r.files] as const)])
    const release = (r: NonNullable<MockRepo['releases']>[number]) => ({ tag_name: r.tag, name: r.name ?? r.tag, prerelease: !!r.prerelease, draft: false, published_at: '2026-10-01T00:00:00Z', html_url: `https://github.example/${name}/releases/tag/${r.tag}`, assets: [] })
    if (repo.private && !isDownload && !opts.token) {
      // Comme GitHub : un dépôt privé inaccessible est « introuvable ».
      if (!tok || (tok.repos && !tok.repos.includes(name))) return json(res, 404, { message: 'Not Found' })
      const org = name.split('/')[0]!
      if (tok.ssoUnauthorized?.includes(org)) {
        res.writeHead(403, { 'content-type': 'application/json', 'x-github-sso': `required; url=https://github.example/orgs/${org}/sso?authorization_request=x` })
        return res.end(JSON.stringify({ message: 'Resource protected by organization SAML enforcement.' }))
      }
    }
    if (tok?.scopes) res.setHeader('x-oauth-scopes', tok.scopes.join(', '))
    const rest = m?.[2] ?? ''
    const branch = repo.branch ?? 'main'
    const branches = repo.branches ??= {}
    const nextNumber = () => Math.max(0, ...(repo.issues ?? []).map(i => i.number), ...(repo.pulls ?? []).map(p => p.number)) + 1
    const html = (kind: string, n: number) => `https://github.example/${name}/${kind}/${n}`
    // Écritures : jeton exigé, comme sur GitHub.
    if (req.method !== 'GET' && !bearer && !opts.token) return json(res, 401, { message: 'Requires authentication' })
    if (req.method === 'POST' && rest === '/deployments') {
      const dep = { id: 1000 + (repo.deployments?.length ?? 0), ref: String(input?.ref ?? ''), environment: String(input?.environment ?? ''), description: String(input?.description ?? ''), production: input?.production_environment === true, statuses: [] as { state: string, description: string, logUrl: string | null, environmentUrl: string | null }[] }
      ;(repo.deployments ??= []).push(dep)
      return json(res, 201, { id: dep.id })
    }
    const depStatus = /^\/deployments\/(\d+)\/statuses$/.exec(rest)
    if (req.method === 'POST' && depStatus) {
      const dep = repo.deployments?.find(d => d.id === Number(depStatus[1]))
      if (!dep) return json(res, 404, { message: 'Not Found' })
      dep.statuses.push({ state: String(input?.state ?? ''), description: String(input?.description ?? ''), logUrl: input?.log_url ? String(input.log_url) : null, environmentUrl: input?.environment_url ? String(input.environment_url) : null })
      return json(res, 201, { id: dep.statuses.length })
    }
    if (req.method === 'POST' && rest === '/issues') {
      const issue = { number: nextNumber(), title: String(input?.title ?? ''), body: String(input?.body ?? ''), state: 'open' as const }
      ;(repo.issues ??= []).push(issue)
      return json(res, 201, { number: issue.number, html_url: html('issues', issue.number) })
    }
    if (req.method === 'POST' && rest === '/git/refs') {
      const ref = String(input?.ref ?? '').replace(/^refs\/heads\//, '')
      const from = String(input?.sha ?? '')
      if (branches[ref]) return json(res, 422, { message: 'Reference already exists' })
      const files = from === sha ? repo.files : null
      if (!files) return json(res, 422, { message: 'Object does not exist' })
      branches[ref] = { ...files }
      return json(res, 201, { ref: `refs/heads/${ref}`, object: { sha: from } })
    }
    const put = req.method === 'PUT' ? /^\/contents\/(.+)$/.exec(rest) : null
    if (put) {
      const target = branches[String(input?.branch ?? '')]
      if (!target) return json(res, 404, { message: 'Branch not found' })
      const path = decodeURIComponent(put[1]!)
      if (target[path] !== undefined && input?.sha !== sha1(target[path]!)) return json(res, 409, { message: 'sha does not match' })
      target[path] = Buffer.from(String(input?.content ?? ''), 'base64').toString('utf8')
      return json(res, 200, { content: { path, sha: sha1(target[path]!) } })
    }
    if (req.method === 'POST' && rest === '/pulls') {
      if (!branches[String(input?.head ?? '')]) return json(res, 422, { message: 'Validation Failed', errors: [{ field: 'head', code: 'invalid' }] })
      const pull = { number: nextNumber(), title: String(input?.title ?? ''), body: String(input?.body ?? ''), head: String(input?.head), base: String(input?.base ?? branch), state: 'open' as const, merged: false }
      ;(repo.pulls ??= []).push(pull)
      return json(res, 201, { number: pull.number, html_url: html('pull', pull.number) })
    }
    const issueNo = /^\/(issues|pulls)\/(\d+)$/.exec(rest)
    if (issueNo) {
      const n = Number(issueNo[2])
      const pull = repo.pulls?.find(p => p.number === n)
      const issue = repo.issues?.find(i => i.number === n)
      if (issueNo[1] === 'pulls') return pull ? json(res, 200, { number: n, state: pull.state, merged: pull.merged, merged_at: pull.merged ? '2026-10-30T12:00:00Z' : null, html_url: html('pull', n), closed_at: pull.state === 'closed' ? '2026-10-30T12:00:00Z' : null }) : json(res, 404, { message: 'Not Found' })
      const it = pull ?? issue
      if (!it) return json(res, 404, { message: 'Not Found' })
      return json(res, 200, { number: n, title: it.title, state: it.state, html_url: html(pull ? 'pull' : 'issues', n), closed_at: it.state === 'closed' ? '2026-10-30T12:00:00Z' : null, ...(pull ? { pull_request: { url: html('pull', n) } } : {}) })
    }
    const head = /^\/git\/ref\/heads\/(.+)$/.exec(rest)?.[1]
    if (head && head !== branch && branches[head]) return json(res, 200, { object: { sha: commitOf({ files: branches[head] }), type: 'commit' } })
    if (dl) {
      if (!versions.has(dl[2]!)) return json(res, 404, { message: 'Not Found' })
      // Dépôt privé : lien pré-signé uniquement (jeton temporaire, sans en-tête Authorization).
      if (repo.private && !opts.token && url.searchParams.get('token') !== sha1(`dl:${name}:${dl[2]}`)) return json(res, 404, { message: 'Not Found' })
      const root = `${name.replace('/', '-')}-${dl[2]!.slice(0, 7)}`
      const zip = makeZip([{ name: `${root}/`, mode: 0o040755 }, ...Object.entries(versions.get(dl[2]!)!).map(([p, c]) => ({ name: `${root}/${p}`, data: c }))])
      res.writeHead(200, { 'content-type': 'application/zip', 'content-length': zip.length })
      return res.end(zip)
    }
    if (rest === '') {
      const priv = repo.private ?? !!opts.token
      return json(res, 200, { full_name: name, private: priv, visibility: priv ? 'private' : 'public', default_branch: branch, html_url: `https://github.example/${name}` })
    }
    if (rest === `/git/ref/heads/${branch}`) return json(res, 200, { object: { sha, type: 'commit' } })
    if (repo.tag && rest === `/git/ref/tags/${repo.tag}`) return json(res, 200, { object: { sha: sha1(`tag:${sha}`), type: 'tag' } })
    if (repo.tag && rest === `/git/tags/${sha1(`tag:${sha}`)}`) return json(res, 200, { object: { sha, type: 'commit' } })
    const relTag = /^\/git\/ref\/tags\/(.+)$/.exec(rest)?.[1]
    const relByTag = repo.releases?.find(r => r.tag === relTag)
    if (relByTag) return json(res, 200, { object: { sha: commitOf({ files: relByTag.files }), type: 'commit' } })
    if (rest === '/actions/artifacts') {
      const page = Number(url.searchParams.get('page') ?? 1)
      const list = page > 1 ? [] : repo.artifacts ?? []
      return json(res, 200, { total_count: list.length, artifacts: list.map(a => ({ id: a.id, name: a.name, size_in_bytes: a.sizeBytes, expired: a.expired, created_at: a.createdAt, expires_at: a.expiresAt, workflow_run: { id: a.id * 10, head_branch: a.branch ?? 'main' } })) })
    }
    if (rest.startsWith('/releases')) {
      const list = repo.releases ?? []
      if (rest === '/releases') return json(res, 200, list.map(release))
      const latest = list.find(r => !r.prerelease)
      if (rest === '/releases/latest') return latest ? json(res, 200, release(latest)) : json(res, 404, { message: 'Not Found' })
      const byTag = list.find(r => rest === `/releases/tags/${r.tag}`)
      return byTag ? json(res, 200, release(byTag)) : json(res, 404, { message: 'Not Found' })
    }
    const commitAsked = /^\/commits\/([0-9a-f]{7,40})$/.exec(rest)?.[1]
    const commitSha = commitAsked ? [...versions.keys()].find(v => v.startsWith(commitAsked)) : undefined
    if (commitSha) {
      return json(res, 200, { sha: commitSha, html_url: `https://github.example/${name}/commit/${commitSha}`, commit: { message: 'Commit de test\n\ndétail', author: { name: 'Test', date: '2026-10-01T00:00:00Z' } } })
    }
    const treeSha = /^\/git\/trees\/([0-9a-f]{40})$/.exec(rest)?.[1]
    if (treeSha && versions.has(treeSha) && url.searchParams.get('recursive') === '1') {
      const files = versions.get(treeSha)!
      const dirs = new Set<string>()
      for (const p of Object.keys(files)) p.split('/').slice(0, -1).forEach((_, i, a) => dirs.add(a.slice(0, i + 1).join('/')))
      const tree = [
        ...[...dirs].map(path => ({ path, type: 'tree', sha: sha1(path) })),
        ...Object.entries(files).map(([path, c]) => ({ path, type: 'blob', sha: sha1(c), size: Buffer.byteLength(c) })),
        ...(treeSha === sha ? Object.entries(repo.submodules ?? {}).map(([path, s]) => ({ path, type: 'commit', sha: shaOf(s.repository) ?? '0'.repeat(40) })) : []),
      ]
      return json(res, 200, { sha: treeSha, tree, truncated: false })
    }
    const contents = /^\/contents\/(.+)$/.exec(rest)
    const at = url.searchParams.get('ref')
    // Référence : commit connu, branche suivie (dernier commit) ou branche créée.
    const filesAt = at ? versions.get(at) ?? (at === branch ? repo.files : branches[at]) : undefined
    if (contents && filesAt) {
      const path = decodeURIComponent(contents[1]!)
      const c = filesAt[path]
      if (c === undefined) return json(res, 404, { message: 'Not Found' })
      if ((req.headers.accept ?? '').includes('raw')) {
        res.writeHead(200, { 'content-type': 'text/plain', 'content-length': Buffer.byteLength(c) })
        return res.end(c)
      }
      return json(res, 200, { type: 'file', path, sha: sha1(c), encoding: 'base64', content: Buffer.from(c, 'utf8').toString('base64') })
    }
    const zipSha = /^\/zipball\/([0-9a-f]{40})$/.exec(rest)?.[1]
    if (zipSha && versions.has(zipSha)) {
      res.writeHead(302, { location: `/_download/${name}/${zipSha}${repo.private && !opts.token ? `?token=${sha1(`dl:${name}:${zipSha}`)}` : ''}` })
      return res.end()
    }
    return json(res, 404, { message: 'Not Found' })
  }
}

/** Lit un répertoire local comme contenu de dépôt. */
export function filesFromDir(dir: string): Record<string, string> {
  const out: Record<string, string> = {}
  const walk = (d: string) => {
    for (const e of readdirSync(d)) {
      const full = join(d, e)
      if (statSync(full).isDirectory()) walk(full)
      else out[relative(dir, full)] = readFileSync(full, 'utf8')
    }
  }
  walk(dir)
  return out
}

if (process.argv[1]?.endsWith('mock-github.ts')) {
  // <port> <org/depot> <répertoire> [token] [--private] : avec --private, le dépôt est
  // privé et le token donne accès ; sinon, le token (facultatif) est exigé partout.
  const args = process.argv.slice(2)
  const priv = args.includes('--private')
  const [port, name, dir, token] = args.filter(a => a !== '--private')
  const repo = { files: filesFromDir(dir!), branch: 'main', tag: 'v1.0.0', private: priv }
  createMockGithub({ [name!]: repo }, priv ? { tokens: token ? { [token]: {} } : {} } : { token }).listen(Number(port), '0.0.0.0', () => {
    console.info(`Faux GitHub sur :${port} — ${name}@main = ${commitOf(repo)} (${Object.keys(repo.files).length} fichiers)`)
  })
}
