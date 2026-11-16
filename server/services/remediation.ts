/**
 * Demandes de correction des vulnérabilités, depuis la page Vulnérabilités : la console trouve le
 * dépôt GitHub d'où vient l'image (source GitHub du projet pour une image qu'elle construit, label
 * OCI « org.opencontainers.image.source », package d'un connecteur GitHub) ou le code source,
 * prépare le texte et les modifications (versions épinglées des requirements, mise à jour des
 * paquets système dans le Dockerfile), ouvre l'issue ou la PR, puis suit la demande : état GitHub
 * (ouverte, fermée, fusionnée) et résolution constatée par une analyse suivante.
 */
import { and, desc, eq, inArray, isNotNull, or } from 'drizzle-orm'
import { createError } from 'h3'
import { type RemediationCreateInput, type RemediationDraft, type RemediationDraftInput, type RemediationRequestDto, type RemediationSubject, imageRefKey, imageSubjectKey, sourceSubjectKey } from '../../shared/schemas/remediation'
import type { Finding, ImageScanDto, Severity, SeverityCounts } from '../../shared/schemas/trivy'
import { portainer } from '../adapters/portainer'
import { db, schema } from '../db/client'
import { type GithubSource, GithubError, normalizeApiUrl } from '../lib/github'
import { type RemediationGroup, groupFindings, isRequirementsFile, newIssueUrl, osFamily, parseIssueUrl, patchDockerfileOsUpgrade, patchRequirements, remediationBranch, repositoryFromUrl, requestBody, requestTitle, webUrlOf } from '../lib/remediation'
import { decryptSecret } from '../utils/crypto'
import { env } from '../utils/env'
import { allowedGithubApis, github } from './sources'
import { connectionFor } from './servers'
import { trivySettings } from './trivy'
import { trimTrailingSlashes } from '../../shared/utils/trim'

const REPOSITORY_RE = /^[A-Za-z0-9][A-Za-z0-9-]{0,38}\/[A-Za-z0-9._-]{1,100}$/

interface ResolvedSubject {
  type: 'image' | 'source'
  key: string
  label: string
  /** Nom dans le titre : image, ou dépôt et référence. */
  name: string
  os: string | null
  scannedAt: string
  counts: SeverityCounts
  fixable: number
  findings: Finding[]
  endpointId: string | null
  imageRef: string | null
  targetId: string | null
  serverName: string
  targets: ImageScanDto['targets']
  repo: { apiUrl: string, repository: string, origin: 'project' | 'label' | 'package' } | null
  /** PR possible : chemins du dépôt connus (source GitHub du projet). */
  pr: { base: string | null, dockerfile: string | null, requirements: string[], pipFromImage: boolean } | null
}

const firstApi = () => allowedGithubApis()[0] ?? 'https://api.github.com'

async function projectGithubSource(projectId: string) {
  const [s] = await db().select().from(schema.projectSources).where(eq(schema.projectSources.projectId, projectId))
  return s?.kind === 'github' && s.repository ? s : null
}

/** Fichiers requirements relevés par l'analyse du code source de la cible (chemins du dépôt). */
async function targetRequirements(targetId: string): Promise<string[]> {
  const [s] = await db().select({ manifests: schema.sourceScans.manifests }).from(schema.sourceScans).where(eq(schema.sourceScans.targetId, targetId))
  return (s?.manifests ?? []).filter(isRequirementsFile)
}

async function resolveSubject(subject: RemediationSubject): Promise<ResolvedSubject> {
  if (subject.type === 'image') {
    const [r] = await db().select({ s: schema.imageScans, server: schema.portainerServers, ep: schema.serverEndpoints }).from(schema.imageScans)
      .innerJoin(schema.serverEndpoints, eq(schema.serverEndpoints.id, schema.imageScans.endpointId))
      .innerJoin(schema.portainerServers, eq(schema.portainerServers.id, schema.serverEndpoints.serverId))
      .where(eq(schema.imageScans.id, subject.id))
    if (!r) throw createError({ statusCode: 404, statusMessage: 'Analyse introuvable' })
    const s = r.s
    const base = {
      type: 'image' as const, key: imageSubjectKey(s.endpointId, s.image), label: s.image, name: s.image, os: s.os, scannedAt: s.scannedAt.toISOString(),
      counts: s.counts, fixable: s.fixable, findings: s.findings, endpointId: s.endpointId, imageRef: imageRefKey(s.image), targetId: null, serverName: r.server.name, targets: s.targets,
    }
    // Image construite par la console : dépôt et Dockerfile de la source GitHub du projet.
    const t = s.targets[0]
    if (s.image.startsWith('platform/') && t) {
      const src = await projectGithubSource(t.projectId)
      if (src) {
        const tag = s.image.slice(s.image.lastIndexOf(':') + 1)
        const [rel] = await db().select({ analysis: schema.releases.analysis }).from(schema.releases).where(and(eq(schema.releases.targetId, t.targetId), eq(schema.releases.slug, tag)))
        const builds = (rel?.analysis as { builds?: { service: string, context: string, dockerfile: string }[] } | null)?.builds ?? []
        const b = builds.find(x => t.services.includes(x.service)) ?? builds[0]
        // Contexte « . » ou « ./sous-dossier » : chemin du dépôt sans préfixe.
        const ctx = trimTrailingSlashes((b?.context ?? '').replace(/^\.(\/|$)/, ''))
        return {
          ...base,
          repo: { apiUrl: normalizeApiUrl(src.apiUrl), repository: src.repository!, origin: 'project' },
          pr: { base: src.refType === 'branch' ? src.ref : null, dockerfile: b ? (ctx ? `${ctx}/${b.dockerfile}` : b.dockerfile).replace(/^\.\//, '') : null, requirements: await targetRequirements(t.targetId), pipFromImage: true },
        }
      }
    }
    // Image d'un registre : dépôt déclaré par l'image, sinon package d'un connecteur GitHub.
    let label = s.sourceUrl
    if (!label) {
      label = await portainer().imageConfig(await connectionFor(r.server), r.ep.portainerEndpointId, s.image)
        .then(c => c?.labels['org.opencontainers.image.source'] ?? null).catch(() => null)
    }
    if (label) {
      for (const api of allowedGithubApis()) {
        const repository = repositoryFromUrl(label, api)
        if (repository) return { ...base, repo: { apiUrl: api, repository, origin: 'label' }, pr: null }
      }
    }
    const ghcr = /^ghcr\.io\/([^/]+)\/([^:@]+)/i.exec(s.image)
    if (ghcr) {
      const connectors = await db().select({ apiUrl: schema.githubConnectors.apiUrl, owner: schema.githubConnectors.owner, snapshot: schema.githubConnectors.snapshot }).from(schema.githubConnectors)
      for (const c of connectors.filter(x => x.owner.toLowerCase() === ghcr[1]!.toLowerCase())) {
        const pkg = c.snapshot?.packages.find(p => p.type === 'container' && p.name.toLowerCase() === ghcr[2]!.toLowerCase())
        if (pkg?.repository) return { ...base, repo: { apiUrl: c.apiUrl, repository: pkg.repository, origin: 'package' }, pr: null }
      }
    }
    return { ...base, repo: null, pr: null }
  }

  const [r] = await db().select({ s: schema.sourceScans, t: schema.projectTargets, project: schema.projects, env: schema.environments, server: schema.portainerServers, rel: schema.releases })
    .from(schema.sourceScans)
    .innerJoin(schema.projectTargets, eq(schema.projectTargets.id, schema.sourceScans.targetId))
    .innerJoin(schema.projects, eq(schema.projects.id, schema.projectTargets.projectId))
    .innerJoin(schema.environments, eq(schema.environments.id, schema.projectTargets.environmentId))
    .innerJoin(schema.serverEndpoints, eq(schema.serverEndpoints.id, schema.projectTargets.endpointId))
    .innerJoin(schema.portainerServers, eq(schema.portainerServers.id, schema.serverEndpoints.serverId))
    .leftJoin(schema.releases, eq(schema.releases.id, schema.sourceScans.releaseId))
    .where(eq(schema.sourceScans.id, subject.id))
  if (!r) throw createError({ statusCode: 404, statusMessage: 'Analyse introuvable' })
  const label = `${r.project.name} (${r.env.name})`
  const src = await projectGithubSource(r.project.id)
  const origin = (r.rel?.metadata as { githubRelease?: { apiUrl: string, repository: string } } | null)?.githubRelease
  const repository = r.rel?.repository ?? origin?.repository ?? src?.repository ?? null
  const apiUrl = normalizeApiUrl(src?.apiUrl ?? origin?.apiUrl ?? firstApi())
  const ref = r.rel?.sourceRef?.replace(/^(branch|tag|commit):/, '') ?? null
  return {
    type: 'source', key: sourceSubjectKey(r.t.id), label, name: repository ? `${repository}${ref ? `@${ref}` : ''}` : label, os: null, scannedAt: r.s.scannedAt.toISOString(),
    counts: r.s.counts, fixable: r.s.fixable, findings: r.s.findings, endpointId: r.t.endpointId, imageRef: null, targetId: r.t.id, serverName: r.server.name,
    targets: [{ targetId: r.t.id, projectId: r.project.id, label, services: [] }],
    repo: repository ? { apiUrl, repository, origin: 'project' } : null,
    // Chemins du dépôt connus seulement pour une release issue du dépôt lui-même.
    pr: r.rel?.sourceKind === 'github' && src ? { base: src.refType === 'branch' ? src.ref : null, dockerfile: null, requirements: r.s.manifests.filter(isRequirementsFile), pipFromImage: false } : null,
  }
}

/** Jeton pour ce dépôt : saisi pour la demande, connecteur GitHub du compte, ou source GitHub d'un projet. */
async function credentialsFor(apiUrl: string, repository: string, oneTime?: string | null): Promise<{ token: string | null, label: string | null }> {
  if (oneTime) return { token: oneTime, label: 'jeton saisi pour cette demande' }
  const owner = repository.split('/')[0]!.toLowerCase()
  const decrypt = async (secretId: string) => {
    const [s] = await db().select({ envelope: schema.secrets.envelope }).from(schema.secrets).where(eq(schema.secrets.id, secretId))
    return s ? decryptSecret(s.envelope) : null
  }
  for (const c of await db().select().from(schema.githubConnectors)) {
    if (normalizeApiUrl(c.apiUrl) === apiUrl && c.owner.toLowerCase() === owner) {
      const token = await decrypt(c.tokenSecretId)
      if (token) return { token, label: `connecteur GitHub « ${c.name} »` }
    }
  }
  const sources = await db().select({ s: schema.projectSources, name: schema.projects.name }).from(schema.projectSources)
    .innerJoin(schema.projects, eq(schema.projects.id, schema.projectSources.projectId))
    .where(and(eq(schema.projectSources.kind, 'github'), isNotNull(schema.projectSources.tokenSecretId)))
  for (const { s, name } of sources) {
    if (normalizeApiUrl(s.apiUrl) === apiUrl && s.repository?.toLowerCase() === repository.toLowerCase()) {
      const token = await decrypt(s.tokenSecretId!)
      if (token) return { token, label: `source GitHub du projet « ${name} »` }
    }
  }
  return { token: null, label: null }
}

interface PlannedChange { path: string, summary: string, content: string, sha: string | null }

/** Modifications des fichiers du dépôt à la tête de la branche de base (versions épinglées, paquets système). */
async function plannedChanges(r: ResolvedSubject, groups: RemediationGroup[], src: GithubSource, ref: string, lang: 'fr' | 'en'): Promise<PlannedChange[]> {
  if (!r.pr) return []
  const gh = github()
  const out: PlannedChange[] = []
  const pip = groups.filter(g => g.kind === 'lang' && g.fixed && (r.pr!.pipFromImage ? g.files.some(f => /python|site-packages|\.(dist|egg)-info|requirements/i.test(f)) : g.files.some(isRequirementsFile)))
  for (const path of r.pr.requirements) {
    const bumps = new Map(pip.filter(g => r.pr!.pipFromImage || g.files.includes(path)).map(g => [g.pkg, g.fixed!]))
    if (!bumps.size) continue
    const file = await gh.fileAt(src, ref, path)
    if (!file) continue
    const p = patchRequirements(file.content, bumps)
    if (p.changed.length) out.push({ path, summary: p.changed.map(c => `${c.pkg} ${c.from} → ${c.to}`).join(', '), content: p.text, sha: file.sha })
  }
  const family = osFamily(r.os)
  if (r.pr.dockerfile && family && groups.some(g => g.kind === 'os' && g.fixed)) {
    const file = await gh.fileAt(src, ref, r.pr.dockerfile)
    const p = file ? patchDockerfileOsUpgrade(file.content, family) : null
    if (file && p) out.push({ path: r.pr.dockerfile, summary: lang === 'fr' ? `mise à jour des paquets système après \`FROM ${p.from}\`` : `OS package upgrade after \`FROM ${p.from}\``, content: p.text, sha: file.sha })
  }
  return out
}

/** Image de base de l'étape finale (Dockerfile du dépôt), pour le texte. */
async function baseImageOf(r: ResolvedSubject, src: GithubSource | null, ref: string | null): Promise<string | null> {
  if (!r.pr?.dockerfile || !src || !ref) return null
  const file = await github().fileAt(src, ref, r.pr.dockerfile).catch(() => null)
  const from = file?.content.split('\n').filter(l => /^\s*FROM\s+/i.test(l)).at(-1)
  return from ? from.trim().replace(/^FROM\s+/i, '').replace(/\s+AS\s+\S+$/i, '') : null
}

const writeError = (err: unknown, repository: string): never => {
  if (err instanceof GithubError) {
    if (err.status === 403 || err.status === 404 || err.kind === 'auth') {
      throw createError({ statusCode: 422, statusMessage: `Le jeton ne peut pas écrire sur ${repository} (droits Issues, ou Contents et Pull requests en écriture) : saisir un autre jeton, ou ouvrir la demande sur GitHub`, data: { errors: { token: err.message } } })
    }
    throw createError({ statusCode: 422, statusMessage: `GitHub : ${err.message}` })
  }
  throw err
}

function contextLines(r: ResolvedSubject, lang: 'fr' | 'en'): string[] {
  const projects = r.targets.map(t => `${t.label}${t.services.length ? ` (${t.services.join(', ')})` : ''}`).join(', ')
  return lang === 'fr'
    ? [`Serveur : ${r.serverName}`, ...(projects ? [`Projets : ${projects}`] : []), `Console : ${env().APP_URL}/vulnerabilities`]
    : [`Server: ${r.serverName}`, ...(projects ? [`Projects: ${projects}`] : []), `Console: ${env().APP_URL}/vulnerabilities`]
}

export async function remediationDraft(input: RemediationDraftInput): Promise<RemediationDraft> {
  const r = await resolveSubject(input.subject)
  const manual = input.repository && input.repository.toLowerCase() !== r.repo?.repository.toLowerCase() ? input.repository : null
  const apiUrl = r.repo?.apiUrl ?? firstApi()
  const repository = manual ?? r.repo?.repository ?? null
  const groups = groupFindings(r.findings, { minSeverity: input.minSeverity as Severity, fixableOnly: input.fixableOnly })
  const settings = await trivySettings()
  const creds = repository ? await credentialsFor(apiUrl, repository) : { token: null, label: null }

  let visibility: RemediationDraft['visibility'] = null
  let repositoryUrl: string | null = null
  let repositoryError: string | null = null
  let defaultBranch: string | null = null
  const src: GithubSource | null = repository ? { apiUrl, repository, token: creds.token } : null
  if (src) {
    try {
      const info = await github().repository(src)
      visibility = info.visibility
      repositoryUrl = info.htmlUrl
      defaultBranch = info.defaultBranch
    }
    catch (err) {
      repositoryError = err instanceof GithubError ? err.message : (err as Error).message
      repositoryUrl = `${webUrlOf(apiUrl)}/${repository}`
    }
  }
  // PR : dépôt connu de la console (pas un dépôt saisi), lisible, et au moins une modification applicable.
  let changes: PlannedChange[] = []
  let prReason: string | null = null
  const base = r.pr?.base ?? defaultBranch
  if (!repository) prReason = 'Dépôt inconnu : le saisir pour préparer une issue'
  else if (manual || !r.pr) prReason = 'Fichiers du dépôt inconnus de la console (image d\'un registre, dépôt saisi) : issue seulement'
  else if (repositoryError || !base) prReason = `Dépôt illisible : ${repositoryError ?? 'branche inconnue'}`
  else {
    try {
      changes = await plannedChanges(r, groups, src!, base, input.lang)
      if (!changes.length) prReason = 'Aucune modification automatique applicable (versions non épinglées, paquets système déjà mis à jour, aucun correctif publié) : issue seulement'
    }
    catch (err) {
      prReason = `Lecture des fichiers impossible : ${(err as Error).message}`
    }
  }
  const kind = input.kind === 'pr' && changes.length ? 'pr' : input.kind === 'issue' || !changes.length ? 'issue' : 'pr'
  const text = {
    lang: input.lang, mode: kind,
    subject: { kind: r.type, name: r.name, os: r.os, scannedAt: r.scannedAt, scanner: settings.image },
    counts: r.counts, fixable: r.fixable,
    selection: { minSeverity: input.minSeverity as Severity, fixableOnly: input.fixableOnly },
    groups, baseImage: await baseImageOf(r, src, base), osFamily: osFamily(r.os),
    changes: changes.map(c => ({ path: c.path, summary: c.summary })),
    context: input.includeContext ? contextLines(r, input.lang) : [],
  } as const
  const title = requestTitle(text)
  const body = requestBody({ ...text, changes: [...text.changes], context: [...text.context] })
  return {
    subjectKey: r.key,
    subjectLabel: r.label,
    repository,
    repositoryOrigin: manual ? 'manual' : r.repo?.origin ?? null,
    apiUrl,
    webUrl: webUrlOf(apiUrl),
    repositoryUrl,
    visibility,
    repositoryError,
    kind,
    title,
    body,
    packages: groups.length,
    vulnerabilities: groups.reduce((a, g) => a + g.vulns.length, 0),
    pr: { available: changes.length > 0, reason: prReason, base, changes: changes.map(c => ({ path: c.path, summary: c.summary })) },
    token: creds.label,
    newIssueUrl: repository ? newIssueUrl(apiUrl, repository, title, body) : null,
    requests: await requestsOf([r.key]),
  }
}

/** Sujet → personnes autorisées : déploiement sur l'un de ses projets, ou administration des règles. */
export async function subjectTargets(subject: RemediationSubject): Promise<{ targets: ImageScanDto['targets'], endpointId: string | null }> {
  const r = await resolveSubject(subject).catch(() => null)
  return { targets: r?.targets ?? [], endpointId: r?.endpointId ?? null }
}

async function record(r: ResolvedSubject, row: { kind: 'issue' | 'pr', apiUrl: string, repository: string, number: number, url: string, title: string, vulnIds: string[], state?: 'open' | 'closed' | 'merged' }, userId: string | null): Promise<RemediationRequestDto> {
  const values = {
    kind: row.kind, subjectType: r.type, endpointId: r.type === 'image' ? r.endpointId : null, imageRef: r.imageRef, targetId: r.targetId, label: r.label,
    apiUrl: row.apiUrl, repository: row.repository, number: row.number, url: row.url, title: row.title.slice(0, 300), vulnIds: row.vulnIds, state: row.state ?? 'open' as const, createdBy: userId, lastSyncAt: new Date(),
  }
  const [saved] = await db().insert(schema.remediationRequests).values(values)
    .onConflictDoUpdate({ target: [schema.remediationRequests.apiUrl, schema.remediationRequests.repository, schema.remediationRequests.number], set: { ...values, createdBy: undefined } })
    .returning()
  return (await toDtos([saved!]))[0]!
}

export async function createRemediation(input: RemediationCreateInput, userId: string | null): Promise<RemediationRequestDto> {
  const r = await resolveSubject(input.subject)
  const apiUrl = r.repo?.apiUrl ?? firstApi()
  const repository = input.repository ?? r.repo?.repository
  if (!repository || !REPOSITORY_RE.test(repository)) throw createError({ statusCode: 422, statusMessage: 'Dépôt GitHub à préciser (org/dépôt)', data: { errors: { repository: 'org/dépôt' } } })
  const creds = await credentialsFor(apiUrl, repository, input.token)
  if (!creds.token) throw createError({ statusCode: 422, statusMessage: `Aucun jeton pour écrire sur ${repository} : saisir un jeton (non conservé), ou ouvrir la demande sur GitHub`, data: { errors: { token: 'Jeton requis' } } })
  const src: GithubSource = { apiUrl, repository, token: creds.token }
  const gh = github()
  const groups = groupFindings(r.findings, { minSeverity: input.minSeverity as Severity, fixableOnly: input.fixableOnly })
  const vulnIds = [...new Set(groups.flatMap(g => g.vulns.map(v => v.id)))]
  if (input.kind === 'issue') {
    const issue = await gh.createIssue(src, { title: input.title, body: input.body }).catch(err => writeError(err, repository))
    return record(r, { kind: 'issue', apiUrl, repository, number: issue.number, url: issue.htmlUrl, title: input.title, vulnIds }, userId)
  }
  if (input.repository && input.repository.toLowerCase() !== r.repo?.repository.toLowerCase()) throw createError({ statusCode: 422, statusMessage: 'PR possible seulement sur le dépôt connu de la console' })
  const info = await gh.repository(src).catch(err => writeError(err, repository))
  const base = r.pr?.base ?? info.defaultBranch
  const changes = (await plannedChanges(r, groups, src, base, input.lang).catch(err => writeError(err, repository)))
    .filter(c => !input.paths.length || input.paths.includes(c.path))
  if (!changes.length) throw createError({ statusCode: 422, statusMessage: 'Aucune modification à proposer : ouvrir une issue' })
  const branch = remediationBranch()
  try {
    const head = await gh.branchHead(src, base)
    await gh.createBranch(src, branch, head)
    for (const c of changes) {
      await gh.putFile(src, { path: c.path, branch, message: `${input.lang === 'fr' ? 'Sécurité' : 'Security'} : ${c.path} — ${c.summary}`.replace(/`/g, ''), content: c.content, sha: c.sha })
    }
    const pull = await gh.createPull(src, { title: input.title, body: input.body, head: branch, base })
    return await record(r, { kind: 'pr', apiUrl, repository, number: pull.number, url: pull.htmlUrl, title: input.title, vulnIds }, userId)
  }
  catch (err) {
    return writeError(err, repository)
  }
}

/** Suivi d'une issue ou d'une PR ouverte à la main (lien collé). */
export async function trackRemediation(subject: RemediationSubject, url: string, userId: string | null): Promise<RemediationRequestDto> {
  const r = await resolveSubject(subject)
  const apis = [r.repo?.apiUrl, ...allowedGithubApis()].filter((x): x is string => !!x)
  let parsed: ReturnType<typeof parseIssueUrl> = null
  let apiUrl = apis[0]!
  for (const api of apis) {
    parsed = parseIssueUrl(url, api)
    if (parsed) {
      apiUrl = api
      break
    }
  }
  if (!parsed) throw createError({ statusCode: 422, statusMessage: 'Lien d\'issue ou de PR GitHub attendu (…/org/dépôt/issues/12 ou …/pull/12)', data: { errors: { url: 'Lien non reconnu' } } })
  const creds = await credentialsFor(apiUrl, parsed.repository)
  const src: GithubSource = { apiUrl, repository: parsed.repository, token: creds.token }
  const issue = await github().issue(src, parsed.number).catch((err) => {
    throw createError({ statusCode: 422, statusMessage: `GitHub : ${(err as Error).message}` })
  })
  const merged = issue.isPull ? (await github().pull(src, parsed.number).catch(() => null))?.merged : false
  const groups = groupFindings(r.findings, { minSeverity: 'HIGH', fixableOnly: true })
  return record(r, { kind: issue.isPull ? 'pr' : 'issue', apiUrl, repository: parsed.repository, number: parsed.number, url: issue.htmlUrl, title: issue.title, vulnIds: [...new Set(groups.flatMap(g => g.vulns.map(v => v.id)))], state: merged ? 'merged' : issue.state }, userId)
}

// ---------------------------------------------------------------------------
// Suivi : état GitHub, résolution constatée par l'analyse
// ---------------------------------------------------------------------------

type RequestRow = typeof schema.remediationRequests.$inferSelect

const keyOf = (r: RequestRow) => (r.subjectType === 'image' ? `image:${r.endpointId}:${r.imageRef}` : sourceSubjectKey(r.targetId ?? ''))

async function toDtos(rows: RequestRow[]): Promise<RemediationRequestDto[]> {
  const ids = [...new Set(rows.map(r => r.createdBy).filter((x): x is string => !!x))]
  const users = ids.length ? await db().select({ id: schema.users.id, email: schema.users.email }).from(schema.users).where(inArray(schema.users.id, ids)) : []
  return rows.map(r => ({
    id: r.id, kind: r.kind, subjectKey: keyOf(r), label: r.label, repository: r.repository, number: r.number, url: r.url, title: r.title, state: r.state,
    vulnCount: r.vulnIds.length, createdAt: r.createdAt.toISOString(), createdBy: users.find(u => u.id === r.createdBy)?.email ?? null,
    lastSyncAt: r.lastSyncAt?.toISOString() ?? null, resolvedAt: r.resolvedAt?.toISOString() ?? null,
  }))
}

async function requestsOf(keys: string[]): Promise<RemediationRequestDto[]> {
  const rows = await db().select().from(schema.remediationRequests).orderBy(desc(schema.remediationRequests.createdAt))
  return (await toDtos(rows)).filter(r => keys.includes(r.subjectKey))
}

/** Demandes des endpoints visibles (images et code source de leurs cibles). */
export async function listRemediationRequests(endpointIds: string[]): Promise<RemediationRequestDto[]> {
  if (!endpointIds.length) return []
  const targets = await db().select({ id: schema.projectTargets.id }).from(schema.projectTargets).where(inArray(schema.projectTargets.endpointId, endpointIds))
  const rows = await db().select().from(schema.remediationRequests)
    .where(or(inArray(schema.remediationRequests.endpointId, endpointIds), ...(targets.length ? [inArray(schema.remediationRequests.targetId, targets.map(t => t.id))] : [])))
    .orderBy(desc(schema.remediationRequests.createdAt))
  return toDtos(rows)
}

/**
 * Résolution constatée : l'analyse la plus récente du sujet (image de même référence sur
 * l'endpoint, ou code source de la cible) ne relève plus aucune des vulnérabilités visées.
 */
export async function markResolvedRequests(): Promise<number> {
  const rows = await db().select().from(schema.remediationRequests).where(inArray(schema.remediationRequests.state, ['open', 'closed', 'merged']))
  let n = 0
  for (const r of rows) {
    let findings: Finding[][] = []
    if (r.subjectType === 'image' && r.endpointId && r.imageRef) {
      const scans = await db().select({ image: schema.imageScans.image, findings: schema.imageScans.findings, status: schema.imageScans.status }).from(schema.imageScans).where(eq(schema.imageScans.endpointId, r.endpointId))
      findings = scans.filter(s => s.status === 'ok' && imageRefKey(s.image) === r.imageRef).map(s => s.findings)
    }
    else if (r.subjectType === 'source' && r.targetId) {
      const [s] = await db().select({ findings: schema.sourceScans.findings, status: schema.sourceScans.status }).from(schema.sourceScans).where(eq(schema.sourceScans.targetId, r.targetId))
      if (s?.status === 'ok') findings = [s.findings]
    }
    // Sujet sans analyse (image retirée…) : pas de conclusion.
    if (!findings.length) continue
    const wanted = new Set(r.vulnIds)
    if (findings.some(list => list.some(f => wanted.has(f.id)))) continue
    await db().update(schema.remediationRequests).set({ state: 'resolved', resolvedAt: new Date() }).where(eq(schema.remediationRequests.id, r.id))
    n++
  }
  return n
}

/** État GitHub des demandes ouvertes (issue fermée, PR fusionnée), puis résolution. */
export async function syncRemediationRequests(): Promise<{ checked: number, changed: number, resolved: number }> {
  const rows = await db().select().from(schema.remediationRequests).where(eq(schema.remediationRequests.state, 'open'))
  let changed = 0
  for (const r of rows) {
    try {
      const creds = await credentialsFor(r.apiUrl, r.repository)
      const src: GithubSource = { apiUrl: r.apiUrl, repository: r.repository, token: creds.token }
      let state: RequestRow['state'] = 'open'
      let closedAt: string | null = null
      if (r.kind === 'pr') {
        const p = await github().pull(src, r.number)
        state = p.merged ? 'merged' : p.state
        closedAt = p.closedAt
      }
      else {
        const i = await github().issue(src, r.number)
        state = i.state
        closedAt = i.closedAt
      }
      if (state !== r.state) changed++
      await db().update(schema.remediationRequests).set({ state, closedAt: closedAt ? new Date(closedAt) : null, lastSyncAt: new Date() }).where(eq(schema.remediationRequests.id, r.id))
    }
    catch (err) {
      console.warn(`[remediation] ${r.repository}#${r.number} : ${(err as Error).message}`)
    }
  }
  return { checked: rows.length, changed, resolved: await markResolvedRequests() }
}
