/**
 * Migration d'un service PostgreSQL d'une cible vers une nouvelle version majeure :
 * plan (montage des données, PGDATA, utilisateur, versions publiées, empêchements) et
 * demande (surcharges d'image et de PGDATA, redéploiement avec l'étape de migration,
 * retour automatique à l'image et aux données d'origine en cas d'échec).
 */
import { and, eq } from 'drizzle-orm'
import { createError } from 'h3'
import type { PgMigrationInput, PgMigrationPlan } from '../../shared/schemas/pg-migration'
import { compareVersions, parseTag } from '../../shared/utils/image-version'
import { portainer } from '../adapters/portainer'
import { runnerFor } from '../adapters/runner'
import { db, schema } from '../db/client'
import type { DeploymentOptions } from '../db/schema'
import { type ImageOverride, normalizeImage } from '../lib/compose/image-upgrade'
import { PG_IMAGE, oldClusterRemovalScript, pgLayout, pgMajorOf } from '../lib/pg-migration'
import { parseImageRef } from '../lib/registry'
import { projectLayout } from '../utils/path-guard'
import { createLifecycleAction } from './deploy-requests'
import { stackOfTarget } from './diagnostic'
import { currentRelease, tagsOf, withTag } from './image-upgrade'
import type { TargetRow } from './projects'
import { connectionFor } from './servers'
import { trimTrailingSlashes } from '../../shared/utils/trim'

const DEFAULT_PGDATA = '/var/lib/postgresql/data'

async function serverRow(t: TargetRow) {
  const [s] = await db().select().from(schema.portainerServers).where(eq(schema.portainerServers.id, t.server.id))
  if (!s) throw createError({ statusCode: 404, statusMessage: 'Serveur introuvable' })
  return s
}

/** Versions majeures publiées plus récentes, de même forme de tag (la plus récente de chaque majeure). */
export function majorCandidates(currentTag: string, tags: readonly string[]): { major: number, tag: string }[] {
  const cur = parseTag(currentTag)
  if (!cur) return []
  const best = new Map<number, ReturnType<typeof parseTag> & object>()
  for (const v of tags.map(parseTag)) {
    if (!v || v.shape !== cur.shape || v.prerelease || (v.nums[0] ?? 0) <= (cur.nums[0] ?? 0)) continue
    const prev = best.get(v.nums[0]!)
    if (!prev || compareVersions(v, prev) > 0) best.set(v.nums[0]!, v)
  }
  return [...best.entries()].sort(([a], [b]) => a - b).map(([major, v]) => ({ major, tag: v.tag }))
}

export async function pgMigrationPlan(t: TargetRow, service: string): Promise<PgMigrationPlan> {
  const rel = await currentRelease(t)
  const image = (rel.images as Record<string, string>)[service]
  if (!image) throw createError({ statusCode: 404, statusMessage: `Service ${service} absent de la release active` })
  const blockers: string[] = []
  const notes: string[] = []
  const plan: PgMigrationPlan = { service, image: normalizeImage(image), currentMajor: pgMajorOf(image), candidates: [], mount: null, pgdata: null, user: null, backupDir: null, blockers, notes }
  if (!PG_IMAGE.test(normalizeImage(image))) {
    blockers.push(`${normalizeImage(image)} n'est pas une image PostgreSQL`)
    return plan
  }
  if (!plan.currentMajor) blockers.push(`Version majeure illisible dans le tag de ${normalizeImage(image)}`)

  // Versions publiées.
  const ref = parseImageRef(image)
  if (ref?.tag) {
    const tags = await tagsOf(ref).catch((err: Error) => {
      blockers.push(`Versions publiées illisibles : ${err.message.slice(0, 160)}`)
      return [] as string[]
    })
    plan.candidates = majorCandidates(ref.tag, tags).map(c => ({ ...c, image: normalizeImage(withTag(image, c.tag)) }))
    if (!plan.candidates.length && !blockers.length) blockers.push('Aucune version majeure plus récente publiée sous la même forme de tag')
  }

  // Conteneur en service : montage des données, PGDATA, superutilisateur.
  const conn = await connectionFor(await serverRow(t))
  const stack = stackOfTarget(t)
  const p = portainer()
  const container = (await p.listContainers(conn, t.endpoint.portainerEndpointId))
    .find(c => c.labels['com.docker.compose.project'] === stack && c.labels['com.docker.compose.service'] === service)
  if (!container) {
    blockers.push(`Aucun conteneur ${service} dans la stack ${stack} : déployer la cible d'abord`)
    return plan
  }
  const cfg = await p.inspectConfig(conn, t.endpoint.portainerEndpointId, container.id)
  if (!cfg) {
    blockers.push(`Conteneur ${service} illisible`)
    return plan
  }
  const env = Object.fromEntries(cfg.env.map(e => [e.slice(0, e.indexOf('=')), e.slice(e.indexOf('=') + 1)]))
  plan.pgdata = env.PGDATA || DEFAULT_PGDATA
  plan.user = env.POSTGRES_USER || 'postgres'
  const within = (child: string, parent: string) => child === parent || child.startsWith(`${trimTrailingSlashes(parent)}/`)
  const m = cfg.mounts.filter(x => within(plan.pgdata!, x.destination)).sort((a, b) => b.destination.length - a.destination.length)[0]
  if (!m || !(m.name || m.source)) blockers.push(`Données (${plan.pgdata}) hors de tout volume : elles disparaîtraient avec le conteneur, migration impossible`)
  else plan.mount = { type: m.type, source: (m.type === 'volume' ? m.name : m.source) ?? '', destination: m.destination }
  if (env.POSTGRES_USER === undefined) notes.push('POSTGRES_USER non défini : superutilisateur « postgres »')
  if (t.target.composeOverrides?.pgData?.[service]) notes.push(`Déjà migré vers PostgreSQL ${t.target.composeOverrides.pgData[service]!.major} (${t.target.composeOverrides.pgData[service]!.path}) : la nouvelle migration repart de ces données`)

  // Sauvegarde : dossier shared/ du projet sur l'hôte.
  const [paths] = await db().select().from(schema.pathConfigs)
    .where(and(eq(schema.pathConfigs.endpointId, t.endpoint.id), eq(schema.pathConfigs.environmentId, t.env.id)))
  if (!paths) blockers.push('Chemins de travail non configurés pour cet endpoint et cet environnement')
  else plan.backupDir = `${projectLayout(paths, t.project.slug, t.target.projectPath).sharedDir}/pg-migration`
  notes.push('La stack est arrêtée pendant la sauvegarde et la restauration (durée selon la taille des bases).')
  notes.push('Les anciennes données restent intactes dans le volume : en cas d\'échec, retour automatique à l\'image actuelle.')
  return plan
}

export async function startPgMigration(t: TargetRow, input: PgMigrationInput, user: { id: string | null, email: string }, idempotencyKey: string): Promise<{ deploymentId: string, from: string, to: string }> {
  if (input.confirm !== input.service) throw createError({ statusCode: 422, statusMessage: 'Confirmation : ressaisir le nom du service', data: { errors: { confirm: 'Ressaisir le nom du service' } } })
  const plan = await pgMigrationPlan(t, input.service)
  if (plan.blockers.length) throw createError({ statusCode: 422, statusMessage: plan.blockers.join(' ; ') })
  const target = plan.candidates.find(c => c.tag === input.tag)
  if (!target) throw createError({ statusCode: 422, statusMessage: `${input.tag} : version majeure non proposée pour ${plan.image}` })

  const rel = await currentRelease(t)
  const images = rel.images as Record<string, string>
  const current = images[input.service]!
  const layout = pgLayout(plan.mount!.destination, plan.pgdata!, plan.user!, target.major)
  const overrides = { ...((t.target.composeOverrides?.images ?? {}) as Record<string, ImageOverride>) }
  const previousPgData = { ...(t.target.composeOverrides?.pgData ?? {}) }
  const next = withTag(current, target.tag)
  const now = new Date().toISOString()
  overrides[input.service] = { image: next, from: overrides[input.service]?.from ?? current, at: now, by: user.email }
  const pgData = { ...previousPgData, [input.service]: { path: layout.newPgdata, major: target.major, at: now, by: user.email, old: { pgdata: layout.oldPgdata, mountSource: plan.mount!.source, mountPath: layout.mountPath, removedAt: null }, backupDir: null } }

  const options: DeploymentOptions = {
    upgrade: {
      services: [{ service: input.service, from: normalizeImage(current), to: normalizeImage(next) }],
      previousImages: (t.target.composeOverrides?.images ?? {}) as Record<string, ImageOverride>,
      previousComposeFinal: rel.composeFinal,
      previousReleaseImages: images,
      previousPgData,
    },
    pgMigration: {
      service: input.service,
      fromImage: current,
      toImage: next,
      targetMajor: target.major,
      mountSource: plan.mount!.source,
      mountPath: layout.mountPath,
      oldPgdata: layout.oldPgdata,
      newPgdata: layout.newPgdata,
      user: layout.user,
    },
  }
  // Surcharges écrites avant la mise en file : l'analyse du redéploiement les applique (restaurées en cas d'échec).
  await db().update(schema.projectTargets).set({ composeOverrides: { ...(t.target.composeOverrides ?? {}), images: overrides, pgData } }).where(eq(schema.projectTargets.id, t.target.id))
  try {
    const deploymentId = await createLifecycleAction(t, 'redeploy', user.id, idempotencyKey, options)
    return { deploymentId, from: normalizeImage(current), to: normalizeImage(next) }
  }
  catch (err) {
    await db().update(schema.projectTargets).set({ composeOverrides: { ...(t.target.composeOverrides ?? {}), images: options.upgrade!.previousImages, pgData: previousPgData } }).where(eq(schema.projectTargets.id, t.target.id))
    throw err
  }
}

/**
 * Suppression de l'ancien cluster après validation de la migration : service en marche et sain
 * sur le nouveau PGDATA, nouveau cluster présent (contrôlé sur l'hôte). Sauvegarde de la
 * migration supprimée en option.
 */
export async function removeOldPgCluster(t: TargetRow, input: { service: string, confirm: string, removeBackup: boolean }): Promise<{ log: string[], backupRemoved: boolean }> {
  if (input.confirm !== input.service) throw createError({ statusCode: 422, statusMessage: 'Confirmation : ressaisir le nom du service', data: { errors: { confirm: 'Ressaisir le nom du service' } } })
  const entry = t.target.composeOverrides?.pgData?.[input.service]
  if (!entry?.old) throw createError({ statusCode: 409, statusMessage: `Aucune migration PostgreSQL enregistrée pour ${input.service}` })
  if (entry.old.removedAt) throw createError({ statusCode: 409, statusMessage: `Ancien cluster déjà supprimé le ${entry.old.removedAt}` })

  // Validation : le conteneur en service tourne, sain, sur le nouveau cluster.
  const conn = await connectionFor(await serverRow(t))
  const p = portainer()
  const c = (await p.listContainers(conn, t.endpoint.portainerEndpointId))
    .find(x => x.labels['com.docker.compose.project'] === stackOfTarget(t) && x.labels['com.docker.compose.service'] === input.service)
  if (!c || c.state !== 'running') throw createError({ statusCode: 409, statusMessage: `${input.service} n'est pas en marche : valider la nouvelle version avant de supprimer l'ancienne` })
  if (/\((unhealthy|health: starting)\)/.test(c.status)) throw createError({ statusCode: 409, statusMessage: `${input.service} n'est pas sain (${c.status}) : suppression refusée` })
  const cfg = await p.inspectConfig(conn, t.endpoint.portainerEndpointId, c.id)
  const pgdata = cfg?.env.find(e => e.startsWith('PGDATA='))?.slice(7)
  if (pgdata !== entry.path) throw createError({ statusCode: 409, statusMessage: `${input.service} n'utilise pas le nouveau cluster (PGDATA=${pgdata ?? 'défaut'}, attendu ${entry.path}) : suppression refusée` })

  const r = await p.runOneShot(conn, t.endpoint.portainerEndpointId, {
    image: process.env.HOST_HELPER_IMAGE || 'busybox:1.37',
    entrypoint: ['sh', '-c'],
    cmd: [oldClusterRemovalScript(entry.old.pgdata, entry.path)],
    binds: [`${entry.old.mountSource}:${entry.old.mountPath}`],
    files: [],
    outputs: [],
    outputLimits: { maxBytes: 0, maxFiles: 0 },
    labels: { 'platform.managed': 'true', 'platform.role': 'pg-cleanup' },
    timeoutMs: 3600_000,
  })
  const log = r.logs.map(l => l.trim()).filter(Boolean)
  if (r.exitCode !== 0) throw createError({ statusCode: 422, statusMessage: `Suppression refusée ou en échec : ${log.at(-1) ?? `code ${r.exitCode}`}` })

  let backupRemoved = false
  if (input.removeBackup && entry.backupDir) {
    const runner = await runnerFor(t.endpoint.id)
    await runner.cleanup({ requestId: crypto.randomUUID(), actor: 'platform' }, { path: entry.backupDir })
    backupRemoved = true
  }
  const [cur] = await db().select({ o: schema.projectTargets.composeOverrides }).from(schema.projectTargets).where(eq(schema.projectTargets.id, t.target.id))
  const pg = { ...(cur?.o.pgData ?? {}) }
  if (pg[input.service]?.old) pg[input.service] = { ...pg[input.service]!, old: { ...pg[input.service]!.old!, removedAt: new Date().toISOString() }, ...(backupRemoved ? { backupDir: null } : {}) }
  await db().update(schema.projectTargets).set({ composeOverrides: { ...(cur?.o ?? {}), pgData: pg } }).where(eq(schema.projectTargets.id, t.target.id))
  return { log, backupRemoved }
}
