/**
 * Connecteurs GitHub : relevé périodique des packages (GitHub Packages) et des artefacts Actions
 * d'un compte, croisé avec les images déployées par la console. Nouvelles alertes notifiées
 * (évènement « github.alert ») ; relevé et alertes conservés pour l'écran d'administration.
 */
import { eq, isNotNull } from 'drizzle-orm'
import { createError } from 'h3'
import type { GithubConnectorDto, GithubConnectorInput, GithubScanSnapshot } from '../../shared/schemas/github-connector'
import { db, schema } from '../db/client'
import { type GithubArtifact, type GithubPackage, type GithubPackageVersion, type GithubSource, GithubError, PACKAGE_TYPES, normalizeApiUrl } from '../lib/github'
import { type DeployedImage, analyzeGithub } from '../lib/github-watch'
import { decryptSecret, encryptSecret } from '../utils/crypto'
import { emitNotification } from './notifications'
import { allowedGithubApis, github } from './sources'

type Row = typeof schema.githubConnectors.$inferSelect

const toDto = (r: Row): GithubConnectorDto => ({
  id: r.id,
  name: r.name,
  apiUrl: r.apiUrl,
  owner: r.owner,
  ownerType: r.ownerType,
  repositories: r.repositories,
  registryHost: r.registryHost,
  expiringDays: r.expiringDays,
  enabled: r.enabled,
  lastScanAt: r.lastScanAt?.toISOString() ?? null,
  lastError: r.lastError,
  counts: {
    packages: r.snapshot?.packages.length ?? 0,
    artifacts: r.snapshot?.artifacts.length ?? 0,
    errors: r.snapshot?.alerts.filter(a => a.level === 'error').length ?? 0,
    warnings: r.snapshot?.alerts.filter(a => a.level === 'warning').length ?? 0,
  },
})

const ghError = (err: unknown): never => {
  throw err instanceof GithubError ? createError({ statusCode: 422, statusMessage: `GitHub : ${err.message}`, data: { errors: { token: err.message } } }) : err
}

function checkApi(apiUrl: string): string {
  const url = normalizeApiUrl(apiUrl)
  if (!allowedGithubApis().includes(url)) throw createError({ statusCode: 422, statusMessage: `Instance GitHub non autorisée : ${url}`, data: { errors: { apiUrl: 'Instance non autorisée par l\'administrateur (GITHUB_ALLOWED_API_URLS)' } } })
  return url
}

async function tokenOf(r: Row): Promise<string> {
  const [s] = await db().select({ envelope: schema.secrets.envelope }).from(schema.secrets).where(eq(schema.secrets.id, r.tokenSecretId))
  if (!s) throw new Error(`Jeton du connecteur ${r.name} introuvable`)
  return decryptSecret(s.envelope)
}

export async function listGithubConnectors(): Promise<GithubConnectorDto[]> {
  return (await db().select().from(schema.githubConnectors)).map(toDto).sort((a, b) => a.name.localeCompare(b.name))
}

export async function githubConnectorOr404(id: string): Promise<Row> {
  const [r] = await db().select().from(schema.githubConnectors).where(eq(schema.githubConnectors.id, id))
  if (!r) throw createError({ statusCode: 404, statusMessage: 'Connecteur introuvable' })
  return r
}

export async function connectorDetail(id: string): Promise<GithubConnectorDto & { snapshot: GithubScanSnapshot | null }> {
  const r = await githubConnectorOr404(id)
  return { ...toDto(r), snapshot: r.snapshot }
}

/** Compte vérifié avec le jeton (type organisation ou utilisateur). */
async function verifyOwner(apiUrl: string, owner: string, token: string) {
  try {
    return await github().owner({ apiUrl, repository: `${owner}/-`, token }, owner)
  }
  catch (err) {
    return ghError(err)
  }
}

export async function createGithubConnector(input: GithubConnectorInput, userId: string | null): Promise<GithubConnectorDto> {
  if (!input.token) throw createError({ statusCode: 422, statusMessage: 'Jeton requis', data: { errors: { token: 'Jeton requis (read:packages, actions:read)' } } })
  const apiUrl = checkApi(input.apiUrl)
  const o = await verifyOwner(apiUrl, input.owner, input.token)
  const { envelope, keyId } = encryptSecret(input.token)
  const row = await db().transaction(async (tx) => {
    const [secret] = await tx.insert(schema.secrets).values({ purpose: 'github_connector_token', envelope, keyId }).returning({ id: schema.secrets.id })
    const [r] = await tx.insert(schema.githubConnectors).values({
      name: input.name, apiUrl, owner: o.login, ownerType: o.type, tokenSecretId: secret!.id, repositories: input.repositories,
      registryHost: input.registryHost.toLowerCase(), expiringDays: input.expiringDays, enabled: input.enabled, createdBy: userId,
    }).returning()
    return r!
  }).catch((err: { code?: string }) => {
    if (err.code === '23505') throw createError({ statusCode: 409, statusMessage: 'Un connecteur porte déjà ce nom', data: { errors: { name: 'Nom déjà utilisé' } } })
    throw err
  })
  return toDto(row)
}

export async function updateGithubConnector(id: string, input: Partial<GithubConnectorInput>): Promise<GithubConnectorDto> {
  const r = await githubConnectorOr404(id)
  const apiUrl = input.apiUrl ? checkApi(input.apiUrl) : r.apiUrl
  const token = input.token ?? await tokenOf(r)
  const o = input.owner || input.token || input.apiUrl ? await verifyOwner(apiUrl, input.owner ?? r.owner, token) : null
  if (input.token) {
    const { envelope, keyId } = encryptSecret(input.token)
    await db().update(schema.secrets).set({ envelope, keyId, rotatedAt: new Date() }).where(eq(schema.secrets.id, r.tokenSecretId))
  }
  const [row] = await db().update(schema.githubConnectors).set({
    ...(input.name !== undefined ? { name: input.name } : {}),
    apiUrl,
    ...(o ? { owner: o.login, ownerType: o.type } : {}),
    ...(input.repositories !== undefined ? { repositories: input.repositories } : {}),
    ...(input.registryHost !== undefined ? { registryHost: input.registryHost.toLowerCase() } : {}),
    ...(input.expiringDays !== undefined ? { expiringDays: input.expiringDays } : {}),
    ...(input.enabled !== undefined ? { enabled: input.enabled } : {}),
  }).where(eq(schema.githubConnectors.id, id)).returning()
  return toDto(row!)
}

export async function removeGithubConnector(id: string): Promise<{ name: string }> {
  const r = await githubConnectorOr404(id)
  await db().transaction(async (tx) => {
    await tx.delete(schema.githubConnectors).where(eq(schema.githubConnectors.id, id))
    await tx.delete(schema.secrets).where(eq(schema.secrets.id, r.tokenSecretId))
  })
  return { name: r.name }
}

/** Images des releases actives (service → image), avec leur projet et environnement. */
async function deployedImages(): Promise<DeployedImage[]> {
  const rows = await db().select({ targetId: schema.projectTargets.id, projectId: schema.projects.id, project: schema.projects.name, env: schema.environments.name, images: schema.releases.images })
    .from(schema.projectTargets)
    .innerJoin(schema.releases, eq(schema.releases.id, schema.projectTargets.currentReleaseId))
    .innerJoin(schema.projects, eq(schema.projects.id, schema.projectTargets.projectId))
    .innerJoin(schema.environments, eq(schema.environments.id, schema.projectTargets.environmentId))
    .where(isNotNull(schema.projectTargets.currentReleaseId))
  return rows.flatMap(r => Object.entries(r.images ?? {}).map(([service, image]) => ({ targetId: r.targetId, projectId: r.projectId, label: `${r.project} (${r.env})`, service, image })))
}

/** Refus de l'API GitHub Packages : cause selon le type de jeton. Les artefacts restent relevés. */
export function packagesDenied(token: string | null): string {
  if (token?.startsWith('github_pat_')) return 'Packages : GitHub refuse les jetons fine-grained (github_pat_…) pour l\'API Packages. Utiliser un jeton classique (ghp_…) avec read:packages (et repo pour les packages privés) ; les artefacts restent relevés.'
  return 'Packages : accès refusé par GitHub. Le jeton classique doit avoir read:packages (et repo pour les packages privés), et être autorisé pour l\'organisation si elle impose le SSO ; les artefacts restent relevés.'
}

/** Relevé d'un connecteur : packages et versions, artefacts, alertes ; nouvelles alertes notifiées. */
export async function scanGithubConnector(id: string): Promise<GithubScanSnapshot> {
  const r = await githubConnectorOr404(id)
  const src: GithubSource = { apiUrl: r.apiUrl, repository: `${r.owner}/-`, token: await tokenOf(r) }
  const gh = github()
  // Compte utilisateur du jeton : /user/packages (ses packages privés compris).
  const self = r.ownerType === 'user' && (await gh.viewer(src))?.toLowerCase() === r.owner.toLowerCase()
  const owner = { login: r.owner, type: self ? 'self' as const : r.ownerType }
  const errors: string[] = []
  const packages: { pkg: GithubPackage, versions: GithubPackageVersion[] }[] = []
  let denied = false
  for (const type of PACKAGE_TYPES) {
    if (denied) break
    const list = await gh.packages(src, owner, type).catch((err: Error) => {
      // Accès refusé : même cause pour tous les types, signalée une fois avec sa solution.
      if (err instanceof GithubError && (err.status === 403 || err.status === 401)) {
        denied = true
        errors.push(packagesDenied(src.token))
      }
      // Un type absent n'empêche pas les autres.
      else if (!(err instanceof GithubError && (err.status === 404 || err.status === 400))) errors.push(`Packages ${type} : ${err.message}`)
      return [] as GithubPackage[]
    })
    for (const pkg of list) {
      const versions = await gh.packageVersions(src, owner, pkg).catch((err: Error) => {
        errors.push(`${pkg.name} : versions illisibles (${err.message})`)
        return [] as GithubPackageVersion[]
      })
      packages.push({ pkg, versions })
    }
  }
  // Dépôts suivis : ceux du connecteur, sinon ceux des packages et des sources GitHub des projets du compte.
  let repos = r.repositories
  if (!repos.length) {
    const sources = await db().select({ repository: schema.projectSources.repository, apiUrl: schema.projectSources.apiUrl }).from(schema.projectSources).where(eq(schema.projectSources.kind, 'github'))
    repos = [...new Set([
      ...packages.map(p => p.pkg.repository).filter((x): x is string => !!x),
      ...sources.filter(s => s.repository && normalizeApiUrl(s.apiUrl) === r.apiUrl).map(s => s.repository!),
    ].filter(x => x.toLowerCase().startsWith(`${r.owner.toLowerCase()}/`)))].sort()
  }
  const artifacts: { repository: string, list: GithubArtifact[] }[] = []
  for (const repository of repos) {
    const list = await gh.artifacts({ ...src, repository }).catch((err: Error) => {
      errors.push(`${repository} : artefacts illisibles (${err.message})`)
      return null
    })
    if (list) artifacts.push({ repository, list })
  }
  const analysis = analyzeGithub({ owner: r.owner, registryHost: r.registryHost, packages, artifacts, deployed: await deployedImages(), expiringDays: r.expiringDays })
  const snapshot: GithubScanSnapshot = { scannedAt: new Date().toISOString(), ...analysis, errors }
  await db().update(schema.githubConnectors).set({ snapshot, lastScanAt: new Date(), lastError: errors[0] ?? null }).where(eq(schema.githubConnectors.id, id))

  // Nouvelles alertes depuis le relevé précédent : une notification récapitulative.
  const before = new Set(r.snapshot?.alerts.map(a => a.key) ?? [])
  const fresh = analysis.alerts.filter(a => !before.has(a.key))
  if (fresh.length) {
    await emitNotification({
      event: 'github.alert',
      severity: fresh.some(a => a.level === 'error') ? 'error' : 'warning',
      title: `GitHub ${r.owner} : ${fresh.length} nouvelle(s) alerte(s)`,
      summary: fresh.slice(0, 10).map(a => `${a.subject} — ${a.message}`).join('\n'),
      facts: [{ label: 'Connecteur', value: r.name }, { label: 'Alertes', value: `${analysis.alerts.length} au total` }],
      path: `/admin/github?connector=${r.id}`,
    })
  }
  return snapshot
}

/** Maintenance : connecteurs actifs. */
export async function scanAllGithubConnectors(): Promise<{ scanned: number, alerts: number, failed: number }> {
  const rows = (await db().select({ id: schema.githubConnectors.id, enabled: schema.githubConnectors.enabled }).from(schema.githubConnectors)).filter(r => r.enabled)
  let alerts = 0
  let failed = 0
  for (const { id } of rows) {
    await scanGithubConnector(id).then((s) => { alerts += s.alerts.length }).catch(async (err) => {
      failed++
      await db().update(schema.githubConnectors).set({ lastScanAt: new Date(), lastError: (err as Error).message.slice(0, 500) }).where(eq(schema.githubConnectors.id, id))
    })
  }
  return { scanned: rows.length, alerts, failed }
}
