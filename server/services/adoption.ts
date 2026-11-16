/**
 * Reprise de l'existant (stacks Compose déjà en place) en projets gérés.
 *
 * - Lecture seule jusqu'au premier déploiement : la reprise crée le projet, la
 *   cible (même nom de stack, donc mêmes volumes et réseaux `<stack>_x`), les
 *   expositions et les variables chiffrées, plus une archive contenant le Compose
 *   converti. Rien n'est modifié sur le serveur.
 * - Le premier déploiement suit le circuit normal (analyse, politiques, validation).
 * - Le Compose est reconstruit à partir des conteneurs ; leurs valeurs d'environnement
 *   ne quittent pas le serveur : chiffrées en variables secrètes, jamais renvoyées ni journalisées.
 */
import { createHash } from 'node:crypto'
import { Readable } from 'node:stream'
import { and, eq } from 'drizzle-orm'
import { createError } from 'h3'
import type { AdoptableStack, AdoptionInput, AdoptionNote, AdoptionPreview, TargetAdoption } from '../../shared/schemas/adoption'
import type { Exposure } from '../../shared/schemas/analysis'
import type { DockerContainer, ImageDefaults } from '../adapters/portainer/types'
import { portainer } from '../adapters/portainer'
import { db, schema } from '../db/client'
import { convertCompose, dropMounts, dropPublishedPorts } from '../lib/adoption/convert'
import { reconstructCompose } from '../lib/adoption/reconstruct'
import { flatFromLabels } from '../lib/proxy/flat'
import { proxyKindOf } from '../lib/proxy/others'
import { suggestTraefikConfig } from '../lib/proxy/suggest'
import { interpretDynamic } from '../lib/proxy/traefik'
import { makeZip } from '../lib/zip-writer'
import { encryptSecret } from '../utils/crypto'
import { type Progress, noProgress } from '../utils/progress'
import { validationError } from '../utils/validation'
import type { EndpointRow } from './live'
import { type TargetRow, analyzeForTarget } from './projects'
import { endpointTopology } from './proxy'
import { connectionFor, environmentMaps } from './servers'
import { type StoredUpload, storeUpload } from './uploads'
import { byCode } from '../../shared/utils/compare'

const NIL = '00000000-0000-0000-0000-000000000000'
const stackOf = (c: DockerContainer) => c.labels['com.docker.compose.project'] ?? null

function infrastructureOf(containers: readonly DockerContainer[]): string | null {
  for (const c of containers) {
    if (/portainer\/(portainer|agent)/.test(c.image)) return 'Agent Portainer'
    const kind = proxyKindOf(c.image, (c.ports ?? []).filter(p => p.publicPort).map(p => p.privatePort))
    if (kind) return kind === 'traefik' ? 'Traefik' : kind
  }
  return null
}

export async function listAdoptable(row: EndpointRow): Promise<AdoptableStack[]> {
  const conn = await connectionFor(row.server)
  const p = portainer()
  const epId = row.ep.portainerEndpointId
  const [containers, topo, targets] = await Promise.all([
    p.listContainers(conn, epId),
    endpointTopology(row).catch(() => null),
    db().select({ stack: schema.projectTargets.stackName, projectId: schema.projects.id, projectName: schema.projects.name, environment: schema.environments.name })
      .from(schema.projectTargets)
      .innerJoin(schema.projects, eq(schema.projects.id, schema.projectTargets.projectId))
      .innerJoin(schema.environments, eq(schema.environments.id, schema.projectTargets.environmentId))
      .where(eq(schema.projectTargets.endpointId, row.ep.id)),
  ])
  const names = new Set<string>(containers.map(stackOf).filter((s): s is string => !!s))
  const out: AdoptableStack[] = [...names].map((name) => {
    const cs = containers.filter(c => stackOf(c) === name)
    const t = targets.find(x => x.stack === name)
    return {
      name,
      services: [...new Set(cs.map(c => c.labels['com.docker.compose.service']).filter((s): s is string => !!s))].sort(byCode),
      containers: cs.length,
      running: cs.filter(c => c.state === 'running').length,
      images: [...new Set(cs.map(c => c.image))].sort(byCode),
      hosts: [...new Set((topo?.routes ?? []).filter(r => r.container?.stack === name && !(r.redirectsToHttps && !r.tls)).flatMap(r => r.hosts))].sort(byCode),
      infrastructure: infrastructureOf(cs),
      managedBy: t ? { projectId: t.projectId, projectName: t.projectName, environment: t.environment } : null,
      composeFile: cs[0]?.labels['com.docker.compose.project.config_files'] ?? null,
    }
  })
  return out.sort((a, b) => Number(!!a.managedBy) - Number(!!b.managedBy) || a.name.localeCompare(b.name))
}

interface Prepared {
  preview: AdoptionPreview
  composeText: string
  /** Valeurs internes : jamais renvoyées. */
  variables: Record<string, string>
  exposures: Exposure[]
  environmentId: string
}

/** Contrôles communs : environnement servi par l'endpoint, chemins configurés, identifiant libre, stack libre. */
async function checkInput(row: EndpointRow, input: AdoptionInput) {
  const { idByKey } = await environmentMaps()
  const environmentId = idByKey.get(input.environmentKey)
  if (!environmentId) throw validationError({ environmentKey: 'Environnement inconnu' })
  if (!row.ep.enabled || row.ep.missing) throw validationError({ stack: 'Endpoint désactivé ou absent' })
  const linked = await db().$count(schema.endpointEnvironments, and(eq(schema.endpointEnvironments.endpointId, row.ep.id), eq(schema.endpointEnvironments.environmentId, environmentId)))
  if (!linked) throw validationError({ environmentKey: `L'endpoint ${row.ep.name} n'accepte pas l'environnement ${input.environmentKey}` })
  const paths = await db().$count(schema.pathConfigs, and(eq(schema.pathConfigs.endpointId, row.ep.id), eq(schema.pathConfigs.environmentId, environmentId)))
  if (!paths) throw validationError({ environmentKey: `Chemins de travail non configurés pour ${row.ep.name} / ${input.environmentKey}` })
  const [taken] = await db().select({ id: schema.projects.id }).from(schema.projects).where(eq(schema.projects.slug, input.slug))
  if (taken) throw validationError({ slug: 'Identifiant déjà utilisé' })
  const managed = await db().$count(schema.projectTargets, and(eq(schema.projectTargets.endpointId, row.ep.id), eq(schema.projectTargets.stackName, input.stack)))
  if (managed) throw validationError({ stack: 'Cette stack est déjà gérée par un projet' })
  return environmentId
}

/** Lecture de la stack, conversion et analyse, sans rien enregistrer. */
async function prepare(row: EndpointRow, input: AdoptionInput, environmentId: string, progress: Progress, slugForAnalysis = input.slug): Promise<Prepared> {
  const conn = await connectionFor(row.server)
  const p = portainer()
  const epId = row.ep.portainerEndpointId
  const total = 5

  await progress.step('Lecture de la stack et de ses conteneurs', 1, total)
  const containers = await p.listContainers(conn, epId)
  const cs = containers.filter(c => stackOf(c) === input.stack)
  if (!cs.length) throw validationError({ stack: 'Stack introuvable sur cet endpoint' })
  const notes: AdoptionNote[] = []

  // Compose reconstruit à partir des conteneurs (seul ce qui diffère de l'image est repris).
  const configs = (await Promise.all(cs.map(c => p.inspectConfig(conn, epId, c.id)))).filter(c => c !== null)
  const images: Record<string, ImageDefaults | null> = {}
  for (const img of new Set(configs.map(c => c.image))) images[img] = await p.imageConfig(conn, epId, img).catch(() => null)
  const r = reconstructCompose(input.stack, configs, images)
  const composeText = r.composeText
  const variables = r.variables
  notes.push(...r.notes)
  const file = cs[0]?.labels['com.docker.compose.project.config_files']
  notes.unshift({ level: 'info', service: null, message: `Compose reconstruit à partir des conteneurs${file ? ` (fichier d'origine sur l'hôte : ${file})` : ''}, à relire` })

  await progress.step('Lecture du reverse proxy et des routes', 2, total)
  const topo = await endpointTopology(row, { refresh: true })
  const routes = topo.routes.filter(r => r.container?.stack === input.stack)
  const stackMiddlewares = new Map<string, string>()
  for (const c of cs) for (const m of interpretDynamic(flatFromLabels(c.labels, 'traefik.')).middlewares) stackMiddlewares.set(m.name, m.type)
  const foreignMiddlewareUsers = new Map<string, string[]>()
  for (const r of topo.routes.filter(x => x.container?.stack !== input.stack && x.provider === 'docker')) {
    for (const m of r.middlewares) {
      const [base, prov = 'docker'] = m.split('@') as [string, string | undefined]
      if (prov === 'docker' && stackMiddlewares.has(base)) foreignMiddlewareUsers.set(base, [...(foreignMiddlewareUsers.get(base) ?? []), r.router])
    }
  }

  // Configuration Traefik de la plateforme pour cet environnement, sinon celle proposée.
  const tcs = await db().select().from(schema.traefikConfigs).where(eq(schema.traefikConfigs.endpointId, row.ep.id))
  const tc = tcs.find(c => c.environmentId === environmentId) ?? tcs.find(c => c.environmentId === null) ?? null
  const nets = await db().select({ name: schema.networks.name, policy: schema.networks.policy, missing: schema.networks.missing }).from(schema.networks).where(eq(schema.networks.endpointId, row.ep.id))
  const suggestion = tc ? null : suggestTraefikConfig(topo, nets)
  if (!tc && routes.some(r => r.provider === 'docker' || r.provider === 'nginx')) notes.push({ level: 'warning', service: null, message: 'Le reverse proxy n\'est pas configuré dans la plateforme pour cet endpoint : le configurer (onglet Reverse proxy, détection de l\'existant) avant le premier déploiement' })

  await progress.step('Conversion du Compose', 3, total)
  const conv = convertCompose(composeText, {
    stackName: input.stack,
    traefikNetwork: tc?.networkName ?? suggestion?.config?.networkName ?? null,
    certResolver: tc?.certResolver ?? suggestion?.config?.certResolver ?? null,
    routes,
    stackMiddlewares,
    foreignMiddlewareUsers,
    mounts: Object.fromEntries(cs.map(c => [c.labels['com.docker.compose.service'] ?? c.names[0]!, (c.mounts ?? []).map(m => ({ destination: m.destination, source: m.source }))])),
    runningImages: Object.fromEntries(cs.map(c => [c.labels['com.docker.compose.service'] ?? c.names[0]!, c.image])),
  })
  notes.push(...conv.notes)

  // Ports publiés placés derrière le reverse proxy (assistant de reprise) : port retiré, exposition ajoutée.
  const web = input.webExposures ?? []
  if (web.length) {
    const dropped = dropPublishedPorts(conv.composeText, web)
    conv.composeText = dropped.composeText
    for (const w of dropped.removed) {
      const e = web.find(x => x.service === w.service && x.published === w.published && x.protocol === w.protocol)!
      conv.exposures.push({ service: e.service, host: e.host, port: e.port, pathPrefix: e.pathPrefix, middlewares: [] })
      notes.push({ level: 'info', service: e.service, message: `Port ${e.published}/${e.protocol} remplacé par l'exposition ${e.host}${e.pathPrefix ?? ''} (Traefik de l'endpoint, port ${e.port} du conteneur)` })
    }
  }

  // Ports et montages retirés de la reprise dans l'assistant (non autorisables sur l'endpoint).
  const unpublished = dropPublishedPorts(conv.composeText, input.droppedPorts ?? [])
  conv.composeText = unpublished.composeText
  for (const p of unpublished.removed) notes.push({ level: 'info', service: p.service, message: `Port ${p.published}/${p.protocol} retiré de la reprise (plus publié sur l'hôte)` })
  const unmounted = dropMounts(conv.composeText, input.droppedMounts ?? [])
  conv.composeText = unmounted.composeText
  for (const m of unmounted.removed) notes.push({ level: 'info', service: m.service, message: `Montage ${m.target} retiré de la reprise` })

  await progress.step('Analyse avec les politiques de l\'endpoint', 4, total)
  const [env] = await db().select().from(schema.environments).where(eq(schema.environments.id, environmentId))
  const synthetic = {
    target: { id: NIL, envSecretId: null, exposures: conv.exposures, watchtower: { enabled: false, services: {} }, stackName: input.stack },
    project: { id: NIL, slug: slugForAnalysis, name: input.projectName },
    env: env!,
    endpoint: row.ep,
    server: { id: row.server.id, name: row.server.name },
  } as unknown as TargetRow
  const analysis = await analyzeForTarget(synthetic, {
    composeText: conv.composeText,
    composePath: 'compose.yml',
    files: new Set(['compose.yml']),
    releaseSlug: 'r-0001-xxxxxx',
    portApprovals: input.portApprovals ?? [],
    variables: Object.fromEntries(Object.entries(variables).map(([k, v]) => [k, { value: v, secret: true }])),
    exposures: conv.exposures,
  }, { persist: false })
  // Le Compose final peut contenir des valeurs : seul le résultat structuré est renvoyé.
  analysis.finalYaml = null
  analysis.diff = null

  await progress.step('Synthèse', 5, total)
  const stack: AdoptableStack = {
    name: input.stack,
    services: [...new Set(cs.map(c => c.labels['com.docker.compose.service']).filter((s): s is string => !!s))].sort(byCode),
    containers: cs.length,
    running: cs.filter(c => c.state === 'running').length,
    images: [...new Set(cs.map(c => c.image))].sort(byCode),
    hosts: [...new Set(routes.flatMap(r => r.hosts))].sort(byCode),
    infrastructure: infrastructureOf(cs),
    managedBy: null,
    composeFile: cs[0]?.labels['com.docker.compose.project.config_files'] ?? null,
  }
  if (stack.infrastructure) notes.unshift({ level: 'warning', service: null, message: `Cette stack contient ${stack.infrastructure} : la reprendre la placerait sous le contrôle des déploiements de la plateforme` })
  return {
    preview: { stack, composeText: conv.composeText, exposures: conv.exposures, variables: Object.keys(variables).sort(byCode), notes, analysis, droppedRoutes: conv.droppedRoutes },
    composeText: conv.composeText,
    variables,
    exposures: conv.exposures,
    environmentId,
  }
}

export async function previewAdoption(row: EndpointRow, input: AdoptionInput, progress: Progress = noProgress): Promise<AdoptionPreview> {
  const environmentId = await checkInput(row, input)
  return (await prepare(row, input, environmentId, progress)).preview
}

async function storeCompose(composeText: string, slug: string, userId: string | null): Promise<StoredUpload> {
  const zip = makeZip([{ name: 'compose.yml', data: composeText }])
  return storeUpload(Readable.from(zip), `${slug}-reprise.zip`, userId)
}

export interface AdoptionResult { projectId: string, targetId: string, upload: StoredUpload, preview: AdoptionPreview }

export async function adoptStack(row: EndpointRow, input: AdoptionInput & { acceptDroppedRoutes: boolean }, userId: string | null, progress: Progress = noProgress): Promise<AdoptionResult> {
  const environmentId = await checkInput(row, input)
  const prep = await prepare(row, input, environmentId, progress)
  if (prep.preview.droppedRoutes.length && !input.acceptDroppedRoutes) {
    throw validationError({ acceptDroppedRoutes: `Routes non convertibles à confirmer : ${prep.preview.droppedRoutes.join(' ; ')}` })
  }
  await progress.step('Création du projet, de la cible et des variables chiffrées')
  const adoption: TargetAdoption = {
    at: new Date().toISOString(),
    by: userId,
    stack: input.stack,
    composeSha256: createHash('sha256').update(prep.composeText).digest('hex'),
    exposures: prep.exposures.length,
    variables: prep.preview.variables.length,
    notes: prep.preview.notes.length,
  }
  const { projectId, targetId } = await db().transaction(async (tx) => {
    const [project] = await tx.insert(schema.projects).values({ slug: input.slug, name: input.projectName, description: input.description, ownerUserId: userId }).returning({ id: schema.projects.id })
    let envSecretId: string | null = null
    if (Object.keys(prep.variables).length) {
      const vars = Object.fromEntries(Object.entries(prep.variables).map(([k, v]) => [k, { value: v, secret: true }]))
      const { envelope, keyId } = encryptSecret(JSON.stringify(vars))
      const [s] = await tx.insert(schema.secrets).values({ purpose: 'target_variables', envelope, keyId }).returning({ id: schema.secrets.id })
      envSecretId = s!.id
    }
    const [t] = await tx.insert(schema.projectTargets).values({
      projectId: project!.id,
      endpointId: row.ep.id,
      environmentId,
      stackName: input.stack,
      exposures: prep.exposures,
      envSecretId,
      adoption,
      createdBy: userId,
    }).returning({ id: schema.projectTargets.id })
    return { projectId: project!.id, targetId: t!.id }
  })
  await progress.step('Préparation de l\'archive du Compose converti')
  const upload = await storeCompose(prep.composeText, input.slug, userId)
  return { projectId, targetId, upload, preview: prep.preview }
}

/**
 * Nouvelle archive du Compose converti pour une cible reprise jamais déployée
 * par la plateforme (l'archive précédente a pu expirer). Les expositions et
 * variables de la cible, éventuellement modifiées depuis, sont conservées.
 */
export async function prepareAdoptionUpload(t: TargetRow, userId: string | null, progress: Progress = noProgress): Promise<StoredUpload> {
  if (!t.target.adoption) throw createError({ statusCode: 409, statusMessage: 'Cette cible n\'a pas été reprise de l\'existant' })
  if (t.target.currentReleaseId) throw createError({ statusCode: 409, statusMessage: 'La stack est déjà gérée par la plateforme' })
  const [row] = await db().select({ ep: schema.serverEndpoints, server: schema.portainerServers }).from(schema.serverEndpoints)
    .innerJoin(schema.portainerServers, eq(schema.portainerServers.id, schema.serverEndpoints.serverId))
    .where(eq(schema.serverEndpoints.id, t.endpoint.id))
  const prep = await prepare(row!, { stack: t.target.adoption.stack, projectName: t.project.name, slug: t.project.slug, environmentKey: t.env.key as AdoptionInput['environmentKey'], description: null, portApprovals: [], webExposures: [], droppedPorts: [], droppedMounts: [] }, t.env.id, progress)
  return storeCompose(prep.composeText, t.project.slug, userId)
}
