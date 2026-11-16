/**
 * Projets et cibles de déploiement : variables chiffrées, construction du
 * contexte d'analyse (politiques en vigueur de l'endpoint) et analyse d'un
 * Compose issu d'une archive déposée.
 */
import { and, desc, eq, inArray, isNull, ne, or } from 'drizzle-orm'
import { createError } from 'h3'
import { posix } from 'node:path'
import type { Variable } from '../lib/compose/interpolate'
import { type AnalysisResult, type AnalyzeContext, type Exposure, type PortApproval, analyzeCompose, stackNameFor } from '../lib/compose/analyze'
import { readZipEntry } from '../lib/zip'
import { MAX_ENV_FILE, collectEnvFiles } from './env-files'
import { db, schema } from '../db/client'
import { decryptSecret, encryptSecret } from '../utils/crypto'
import { projectLayout, validateRelativeEntry } from '../utils/path-guard'
import { watchtowerConfig } from '../../shared/schemas/watchtower'
import { initOnlyHint } from '../../shared/utils/variables'
import { effectiveWatchtowerImage } from './update-engine'
import { allocateSubnets, composeNetworkKeys } from './network-pool'
import { profileScope, resolveTargetProfile } from './watchtower-profiles'

export async function getTargetOr404(id: string) {
  const [r] = await db().select({
    target: schema.projectTargets,
    project: schema.projects,
    env: schema.environments,
    endpoint: schema.serverEndpoints,
    server: { id: schema.portainerServers.id, name: schema.portainerServers.name },
  })
    .from(schema.projectTargets)
    .innerJoin(schema.projects, eq(schema.projects.id, schema.projectTargets.projectId))
    .innerJoin(schema.environments, eq(schema.environments.id, schema.projectTargets.environmentId))
    .innerJoin(schema.serverEndpoints, eq(schema.serverEndpoints.id, schema.projectTargets.endpointId))
    .innerJoin(schema.portainerServers, eq(schema.portainerServers.id, schema.serverEndpoints.serverId))
    .where(eq(schema.projectTargets.id, id))
  if (!r) throw createError({ statusCode: 404, statusMessage: 'Cible de déploiement introuvable' })
  return r
}
export type TargetRow = Awaited<ReturnType<typeof getTargetOr404>>

export function targetScope(t: TargetRow) {
  return { projectId: t.project.id, environmentId: t.env.id, serverId: t.server.id }
}

// ---------------------------------------------------------------------------
// Variables (§9) : stockées chiffrées dans un secret JSON par cible
// ---------------------------------------------------------------------------

export async function targetVariables(t: { envSecretId: string | null }): Promise<Record<string, Variable>> {
  if (!t.envSecretId) return {}
  const [s] = await db().select({ envelope: schema.secrets.envelope }).from(schema.secrets).where(eq(schema.secrets.id, t.envSecretId))
  return s ? JSON.parse(decryptSecret(s.envelope)) as Record<string, Variable> : {}
}

export interface VariableInput { name: string, value?: string | null, secret: boolean, inject?: string[] }

/**
 * Remplace la liste des variables. Pour une variable secrète existante, une
 * valeur absente signifie « inchangée » (la valeur n'est jamais renvoyée au client).
 */
export async function setTargetVariables(targetId: string, input: VariableInput[]): Promise<void> {
  const [t] = await db().select().from(schema.projectTargets).where(eq(schema.projectTargets.id, targetId))
  if (!t) throw createError({ statusCode: 404, statusMessage: 'Cible introuvable' })
  const current = await targetVariables(t)
  const next: Record<string, Variable> = {}
  for (const v of input) {
    const prev = current[v.name]
    if (v.value === undefined || v.value === null) {
      if (!prev) throw createError({ statusCode: 422, statusMessage: `Valeur manquante pour ${v.name}` })
      next[v.name] = { value: prev.value, secret: v.secret, ...(v.inject?.length ? { inject: [...new Set(v.inject)] } : {}) }
    }
    else {
      next[v.name] = { value: v.value, secret: v.secret, ...(v.inject?.length ? { inject: [...new Set(v.inject)] } : {}) }
    }
  }
  const { envelope, keyId } = encryptSecret(JSON.stringify(next))
  // Date de changement par variable (valeur nouvelle ou modifiée) : jamais la valeur elle-même.
  const now = new Date().toISOString()
  const meta: Record<string, { updatedAt: string }> = {}
  for (const [name, v] of Object.entries(next)) {
    const prev = current[name]
    meta[name] = !prev || prev.value !== v.value || JSON.stringify(prev.inject ?? []) !== JSON.stringify(v.inject ?? []) ? { updatedAt: now } : (t.variablesMeta?.[name] ?? { updatedAt: new Date(0).toISOString() })
  }
  await db().transaction(async (tx) => {
    await tx.update(schema.projectTargets).set({ variablesMeta: meta }).where(eq(schema.projectTargets.id, targetId))
    if (t.envSecretId) {
      await tx.update(schema.secrets).set({ envelope, keyId, rotatedAt: new Date() }).where(eq(schema.secrets.id, t.envSecretId))
    }
    else {
      const [s] = await tx.insert(schema.secrets).values({ purpose: 'target_variables', envelope, keyId }).returning({ id: schema.secrets.id })
      await tx.update(schema.projectTargets).set({ envSecretId: s!.id }).where(eq(schema.projectTargets.id, targetId))
    }
  })
}

/** Vue publique : les valeurs secrètes ne sortent jamais. */
/**
 * Début du dernier déploiement réussi de la release en service : les variables y sont lues.
 * Null si rien n'est en service (aucune variable n'est alors « à déployer »).
 */
export async function lastActivationAt(target: { id: string, currentReleaseId: string | null }): Promise<Date | null> {
  if (!target.currentReleaseId) return null
  const d = schema.deployments
  const [last] = await db().select({ startedAt: d.startedAt, createdAt: d.createdAt }).from(d)
    .where(and(eq(d.targetId, target.id), inArray(d.action, ['deploy', 'redeploy', 'rollback']), inArray(d.status, ['HEALTHY', 'DEGRADED'])))
    .orderBy(desc(d.createdAt)).limit(1)
  return last ? (last.startedAt ?? last.createdAt) : null
}

/** Variables modifiées après le dernier déploiement en service. */
export function variablesNotDeployed(meta: Record<string, { updatedAt: string }> | null, deployedAt: Date | null): string[] {
  if (!deployedAt || !meta) return []
  return Object.entries(meta).filter(([, m]) => new Date(m.updatedAt) > deployedAt).map(([name]) => name).sort()
}

export function publicVariables(vars: Record<string, Variable>, meta: Record<string, { updatedAt: string }> | null = null, deployedAt: Date | null = null) {
  const pending = new Set(variablesNotDeployed(meta, deployedAt))
  return Object.entries(vars).sort(([a], [b]) => a.localeCompare(b)).map(([name, v]) => ({
    name,
    secret: v.secret,
    value: v.secret ? null : v.value,
    /** Services dont l'environnement reçoit la variable sans que le Compose la cite (« * » : tous). */
    inject: v.inject ?? [],
    /** Modifiée depuis le déploiement en service : appliquée au prochain déploiement. */
    notDeployed: pending.has(name),
    /** Lue seulement à l'initialisation des données : explication, sinon null. */
    initOnly: initOnlyHint(name),
  }))
}

// ---------------------------------------------------------------------------
// Contexte d'analyse : politiques en vigueur au moment de l'appel
// ---------------------------------------------------------------------------

export interface AnalyzeInput {
  composeText: string
  composePath: string
  files: ReadonlySet<string>
  releaseSlug: string
  portApprovals: PortApproval[]
  /** Surcharge des variables enregistrées (prévisualisation). */
  variables?: Record<string, Variable>
  /** Surcharge des expositions enregistrées (prévisualisation). */
  exposures?: Exposure[]
  /** Origine des sources : un dépôt Git fait foi (écart Watchtower à confirmer). */
  sourceKind?: 'zip' | 'github'
  /** Clés des env_file présents dans les sources (sans les valeurs). */
  envFileKeys?: Record<string, string[]>
}

export async function buildAnalyzeContext(t: TargetRow, input: Omit<AnalyzeInput, 'composeText'>): Promise<AnalyzeContext> {
  const endpointId = t.endpoint.id
  const [paths] = await db().select().from(schema.pathConfigs)
    .where(and(eq(schema.pathConfigs.endpointId, endpointId), eq(schema.pathConfigs.environmentId, t.env.id)))
  const [portRules, volumeRules, networks, dockerVolumes, traefikRows, others] = await Promise.all([
    db().select().from(schema.portRules).where(and(eq(schema.portRules.endpointId, endpointId), or(isNull(schema.portRules.environmentId), eq(schema.portRules.environmentId, t.env.id)))),
    db().select().from(schema.volumeRules).where(eq(schema.volumeRules.endpointId, endpointId)),
    db().select().from(schema.networks).where(eq(schema.networks.endpointId, endpointId)),
    db().select({ name: schema.dockerVolumes.name }).from(schema.dockerVolumes).where(and(eq(schema.dockerVolumes.endpointId, endpointId), eq(schema.dockerVolumes.missing, false))),
    db().select().from(schema.traefikConfigs).where(eq(schema.traefikConfigs.endpointId, endpointId)),
    // Hôtes déjà routés par les AUTRES cibles du même endpoint (conflits de domaines).
    db().select({ exposures: schema.projectTargets.exposures, slug: schema.projects.slug, envKey: schema.environments.key })
      .from(schema.projectTargets)
      .innerJoin(schema.projects, eq(schema.projects.id, schema.projectTargets.projectId))
      .innerJoin(schema.environments, eq(schema.environments.id, schema.projectTargets.environmentId))
      .where(and(eq(schema.projectTargets.endpointId, endpointId), ne(schema.projectTargets.id, t.target.id))),
  ])
  // Configuration propre à l'environnement si elle existe, sinon celle par défaut de l'endpoint.
  const tc = traefikRows.find(c => c.environmentId === t.env.id) ?? traefikRows.find(c => c.environmentId === null) ?? null
  const composePath = validateRelativeEntry(input.composePath)
  const composeDir = posix.dirname(composePath) === '.' ? '' : posix.dirname(composePath)
  return {
    projectSlug: t.project.slug,
    projectId: t.project.id,
    environmentKey: t.env.key,
    environmentId: t.env.id,
    releaseSlug: input.releaseSlug,
    composeDir,
    files: input.files,
    variables: input.variables ?? await targetVariables(t.target),
    portRules: portRules.map(r => ({ portFrom: r.portFrom, portTo: r.portTo, protocol: r.protocol, policy: r.policy, description: r.description })),
    portApprovals: input.portApprovals,
    volumeRules: volumeRules.map(r => ({ hostPath: r.hostPath, mode: r.mode, environmentId: r.environmentId, projectId: r.projectId, enabled: r.enabled })),
    runtimeDir: paths ? runtimeDirOf(paths, t.project.slug, t.target.projectPath) : null,
    volumesAsFolders: t.target.volumesAsFolders,
    envFileKeys: input.envFileKeys,
    sourceDir: paths ? sourceDirOf(paths, t.project.slug, t.target.projectPath, input.releaseSlug) : null,
    workingRoots: paths ? [paths.workingRoot, paths.buildRoot, paths.tmpRoot] : [],
    networks: networks.map(n => ({ name: n.name, policy: n.policy, allowedEnvironmentIds: n.allowedEnvironmentIds, missing: n.missing })),
    dockerVolumes: dockerVolumes.map(v => v.name),
    traefik: tc
      ? { networkName: t.target.proxyNetwork ?? tc.networkName, certResolver: tc.certResolver, entrypointHttp: tc.entrypointHttp, entrypointHttps: tc.entrypointHttps, allowedDomains: tc.allowedDomains, defaultMiddlewares: tc.defaultMiddlewares, routerNamePattern: tc.routerNamePattern, exposure: tc.exposure, redirectToHttps: tc.redirectToHttps, provider: tc.provider, letsencrypt: tc.letsencrypt }
      : null,
    exposures: input.exposures ?? t.target.exposures,
    takenHosts: others.flatMap(o => o.exposures.map(e => ({ host: e.host, pathPrefix: e.pathPrefix, owner: `${o.slug} (${o.envKey})` }))),
    watchtower: watchtowerConfig.parse(t.target.watchtower ?? {}),
    watchtowerImage: await effectiveWatchtowerImage(),
    // Watchtower activé : profil du serveur (choisi, ou repris de l'ancien rythme de la cible).
    watchtowerProfile: watchtowerConfig.parse(t.target.watchtower ?? {}).enabled
      ? await resolveTargetProfile(t).then(p => ({ scope: profileScope(p), name: p.name }))
      : null,
    sourceKind: input.sourceKind ?? 'zip',
    stackName: t.target.stackName,
    healthchecks: t.target.composeOverrides?.healthchecks ?? {},
    imageOverrides: t.target.composeOverrides?.images ?? {},
    pgData: t.target.composeOverrides?.pgData ?? {},
    excludedServices: Object.keys(t.target.composeOverrides?.excludedServices ?? {}),
    suspendedServices: Object.keys(t.target.composeOverrides?.suspendedServices ?? {}),
    unpublishedPorts: t.target.composeOverrides?.unpublishedPorts ?? [],
  }
}

/** Répertoire des données du projet : sous le chemin choisi, sinon <runtimeRoot>/<projet>. Null si le chemin est invalide. */
function runtimeDirOf(paths: Parameters<typeof projectLayout>[0], slug: string, projectPath: string | null): string | null {
  try {
    return projectLayout(paths, slug, projectPath).runtimeDir
  }
  catch {
    return projectPath ? null : posix.join(paths.runtimeRoot, slug)
  }
}

/** Sources de la release sur l'hôte (binds relatifs en lecture seule vers des fichiers des sources). */
function sourceDirOf(paths: Parameters<typeof projectLayout>[0], slug: string, projectPath: string | null, releaseSlug: string): string | null {
  try {
    return projectLayout(paths, slug, projectPath).release(releaseSlug).sourceDir
  }
  catch {
    return null
  }
}

/**
 * Analyse avec les sous-réseaux de la plage de l'endpoint (si elle est configurée) : attribués
 * aux réseaux de la stack avant l'analyse. Utilisée par l'aperçu et par la revalidation du déploiement.
 */
export async function analyzeWithSubnets(t: TargetRow, composeText: string, ctx: AnalyzeContext, opts: { persist?: boolean } = {}): Promise<AnalysisResult> {
  const alloc = await allocateSubnets(t, composeNetworkKeys(composeText), opts).catch((err: { statusMessage?: string, message?: string }) => {
    // Erreur technique (base de données…) : message lisible, détail dans les journaux du serveur.
    if (!err.statusMessage) console.error('[analyse] attribution des sous-réseaux', err)
    return { subnets: {}, warnings: [] as string[], error: err.statusMessage ?? 'Attribution du sous-réseau impossible (erreur interne, détail dans les journaux de la console) : réessayer l\'analyse' }
  })
  ctx.networkSubnets = alloc.subnets
  const result = analyzeCompose(composeText, ctx)
  for (const w of alloc.warnings) result.issues.push({ severity: 'warning', code: 'networks.subnet', message: w })
  if ('error' in alloc) {
    result.issues.unshift({ severity: 'error', code: 'networks.pool', message: alloc.error })
    result.ok = false
  }
  return result
}

export async function analyzeForTarget(t: TargetRow, input: AnalyzeInput, opts: { persist?: boolean } = {}): Promise<AnalysisResult> {
  const ctx = await buildAnalyzeContext(t, input)
  const result = await analyzeWithSubnets(t, input.composeText, ctx, opts)
  if (!ctx.runtimeDir) {
    result.issues.unshift({ severity: 'error', code: 'paths.missing', message: `Chemins de travail non configurés pour ${t.endpoint.name} / ${t.env.name}` })
    result.ok = false
  }
  return result
}

export const MAX_COMPOSE_READ = 512 * 1024

/** Compose et liste des fichiers d'une archive déposée. */
export async function sourceFromUpload(upload: { storagePath: string, report: unknown, consumedAt: Date | null }, composePath: string) {
  if (upload.consumedAt) throw createError({ statusCode: 410, statusMessage: 'Archive déjà utilisée ou expirée : la déposer à nouveau' })
  const report = upload.report as { entries?: string[], composeFiles?: string[] }
  const files = new Set(report.entries ?? [])
  const path = validateRelativeEntry(composePath)
  if (!files.has(path)) throw createError({ statusCode: 422, statusMessage: `Fichier Compose absent de l'archive : ${path}` })
  const composeText = await readZipEntry(upload.storagePath, path, MAX_COMPOSE_READ)
  const env = await collectEnvFiles(composeText, path, files, p => readZipEntry(upload.storagePath, p, MAX_ENV_FILE))
  return { composeText, files, composePath: path, envFileKeys: env.keys }
}

export { stackNameFor }
