/** Tableaux transverses (§17) : déploiements, audit, historique des images. Filtres combinables, tri et pagination serveur. */
import { and, asc, count, desc, eq, gte, ilike, inArray, isNotNull, isNull, like, lte, or, sql, type SQL } from 'drizzle-orm'
import { FAILED_STATUSES } from '../../shared/utils/deployment-status'
import type { Paginated } from '../../shared/schemas/common'
import type { AuditListQuery, AuditRow, DeploymentListQuery, DeploymentRow, ImageUpdateListQuery, ImageUpdateRow } from '../../shared/schemas/lists'
import { db, schema } from '../db/client'
import { type CsvColumn, periodRange } from '../utils/table'

const inList = <T>(col: Parameters<typeof inArray>[0], visible: T[] | null): SQL | undefined =>
  visible === null ? undefined : visible.length ? inArray(col, visible as never[]) : sql`false`

const order = (dir: 'asc' | 'desc', col: Parameters<typeof asc>[0]) => (dir === 'asc' ? asc(col) : desc(col))

// ---------------------------------------------------------------------------
// Déploiements
// ---------------------------------------------------------------------------

export async function listDeployments(q: DeploymentListQuery, visibleTargets: string[] | null): Promise<Paginated<DeploymentRow>> {
  const d = schema.deployments
  const p = schema.projects
  const e = schema.environments
  const where: (SQL | undefined)[] = [inList(d.targetId, visibleTargets)]
  const { from, to } = periodRange(q)
  if (from) where.push(gte(d.createdAt, from))
  if (to) where.push(lte(d.createdAt, to))
  if (q.status?.length) where.push(inArray(d.status, q.status))
  if (q.action?.length) where.push(inArray(d.action, q.action))
  if (q.projectId) where.push(eq(p.id, q.projectId))
  if (q.environmentId) where.push(eq(e.id, q.environmentId))
  if (q.serverId) where.push(eq(schema.portainerServers.id, q.serverId))
  if (q.targetId) where.push(eq(d.targetId, q.targetId))
  if (q.buildFailed) where.push(and(eq(d.status, 'FAILED'), eq(d.failedFrom, 'BUILDING')))
  // Projets archivés (essais, E2E) : exclus sauf demande ou filtre explicite sur le projet ou la cible.
  if (!q.archived && !q.projectId && !q.targetId) where.push(isNull(p.archivedAt))
  if (q.unacknowledged) where.push(and(inArray(d.status, [...FAILED_STATUSES]), isNull(d.acknowledgedAt)))
  if (q.q) where.push(or(ilike(p.name, `%${q.q}%`), ilike(p.slug, `%${q.q}%`), ilike(d.error, `%${q.q}%`), ilike(schema.users.email, `%${q.q}%`)))
  const cond = and(...where.filter(Boolean) as SQL[])
  const base = () => db().select({
    d, project: p.name, projectId: p.id, environment: e.name, environmentId: e.id, server: schema.portainerServers.name, release: schema.releases.number, by: schema.users.email,
  }).from(d)
    .innerJoin(schema.projectTargets, eq(schema.projectTargets.id, d.targetId))
    .innerJoin(p, eq(p.id, schema.projectTargets.projectId))
    .innerJoin(e, eq(e.id, schema.projectTargets.environmentId))
    .innerJoin(schema.serverEndpoints, eq(schema.serverEndpoints.id, schema.projectTargets.endpointId))
    .innerJoin(schema.portainerServers, eq(schema.portainerServers.id, schema.serverEndpoints.serverId))
    .leftJoin(schema.releases, eq(schema.releases.id, d.releaseId))
    .leftJoin(schema.users, eq(schema.users.id, d.requestedBy))
  const [sortKey, dir] = (q.sort ?? 'createdAt:desc').split(':') as [string, 'asc' | 'desc']
  const SORT = { createdAt: d.createdAt, finishedAt: d.finishedAt, status: d.status, action: d.action, project: p.name, environment: e.sortOrder } as const
  const col = SORT[sortKey as keyof typeof SORT] ?? d.createdAt
  const [rows, [{ total }]] = await Promise.all([
    base().where(cond).orderBy(order(dir, col), desc(d.createdAt)).limit(q.pageSize).offset((q.page - 1) * q.pageSize),
    db().select({ total: count() }).from(d)
      .innerJoin(schema.projectTargets, eq(schema.projectTargets.id, d.targetId))
      .innerJoin(p, eq(p.id, schema.projectTargets.projectId))
      .innerJoin(e, eq(e.id, schema.projectTargets.environmentId))
      .innerJoin(schema.serverEndpoints, eq(schema.serverEndpoints.id, schema.projectTargets.endpointId))
      .innerJoin(schema.portainerServers, eq(schema.portainerServers.id, schema.serverEndpoints.serverId))
      .leftJoin(schema.users, eq(schema.users.id, d.requestedBy))
      .where(cond),
  ]) as [Awaited<ReturnType<ReturnType<typeof base>['where']>>, [{ total: number }]]
  return {
    items: rows.map(r => ({
      id: r.d.id,
      createdAt: r.d.createdAt.toISOString(),
      finishedAt: r.d.finishedAt?.toISOString() ?? null,
      durationSec: r.d.startedAt && r.d.finishedAt ? Math.round((r.d.finishedAt.getTime() - r.d.startedAt.getTime()) / 1000) : null,
      action: r.d.action,
      status: r.d.status,
      failedFrom: r.d.failedFrom,
      error: r.d.error,
      project: r.project, projectId: r.projectId, environment: r.environment, environmentId: r.environmentId, server: r.server,
      targetId: r.d.targetId, releaseNumber: r.release, requestedBy: r.by,
      acknowledgedAt: r.d.acknowledgedAt?.toISOString() ?? null,
      gate: r.d.status !== 'QUEUED' ? null : r.d.options.approval?.state === 'pending' ? 'pending' as const : r.d.options.schedule ? 'scheduled' as const : null,
      scheduledFor: r.d.status === 'QUEUED' ? r.d.options.schedule?.at ?? null : null,
    })),
    total, page: q.page, pageSize: q.pageSize,
  }
}

export const DEPLOYMENT_CSV: CsvColumn<DeploymentRow>[] = [
  { key: 'createdAt', label: 'Demandé le', value: r => r.createdAt },
  { key: 'project', label: 'Projet', value: r => r.project },
  { key: 'environment', label: 'Environnement', value: r => r.environment },
  { key: 'server', label: 'Serveur', value: r => r.server },
  { key: 'action', label: 'Opération', value: r => r.action },
  { key: 'status', label: 'Statut', value: r => r.status },
  { key: 'releaseNumber', label: 'Release', value: r => r.releaseNumber },
  { key: 'requestedBy', label: 'Demandé par', value: r => r.requestedBy ?? 'système' },
  { key: 'finishedAt', label: 'Terminé le', value: r => r.finishedAt },
  { key: 'durationSec', label: 'Durée (s)', value: r => r.durationSec },
  { key: 'error', label: 'Erreur', value: r => r.error },
]

// ---------------------------------------------------------------------------
// Audit
// ---------------------------------------------------------------------------

export async function listAudit(q: AuditListQuery, visibleProjects: string[] | null): Promise<Paginated<AuditRow>> {
  const a = schema.auditEvents
  const where: (SQL | undefined)[] = []
  // Attribution limitée : seuls les évènements des projets couverts.
  if (visibleProjects !== null) where.push(visibleProjects.length ? and(isNotNull(a.projectId), inArray(a.projectId, visibleProjects)) : sql`false`)
  const { from, to } = periodRange(q)
  if (from) where.push(gte(a.ts, from))
  if (to) where.push(lte(a.ts, to))
  if (q.outcome?.length) where.push(inArray(a.outcome, q.outcome))
  if (q.action) where.push(like(a.action, `${q.action}%`))
  if (q.actor) where.push(ilike(a.actorLabel, `%${q.actor}%`))
  if (q.projectId) where.push(eq(a.projectId, q.projectId))
  if (q.environmentId) where.push(eq(a.environmentId, q.environmentId))
  if (q.serverId) where.push(eq(a.serverId, q.serverId))
  if (q.q) where.push(or(ilike(a.actorLabel, `%${q.q}%`), ilike(a.action, `%${q.q}%`), ilike(a.targetId, `%${q.q}%`), sql`${a.details}::text ilike ${`%${q.q}%`}`))
  const cond = where.length ? and(...where.filter(Boolean) as SQL[]) : undefined
  const [sortKey, dir] = (q.sort ?? 'ts:desc').split(':') as [string, 'asc' | 'desc']
  const SORT = { ts: a.ts, actor: a.actorLabel, action: a.action, outcome: a.outcome } as const
  const col = SORT[sortKey as keyof typeof SORT] ?? a.ts
  const [rows, [{ total }]] = await Promise.all([
    db().select().from(a).where(cond).orderBy(order(dir, col), desc(a.id)).limit(q.pageSize).offset((q.page - 1) * q.pageSize),
    db().select({ total: count() }).from(a).where(cond),
  ]) as [typeof a.$inferSelect[], [{ total: number }]]
  return {
    items: rows.map(r => ({ id: String(r.id), ts: r.ts.toISOString(), actor: r.actorLabel, action: r.action, outcome: r.outcome, targetType: r.targetType, targetId: r.targetId, ip: r.ip, details: r.details as Record<string, unknown> })),
    total, page: q.page, pageSize: q.pageSize,
  }
}

export const AUDIT_CSV: CsvColumn<AuditRow>[] = [
  { key: 'ts', label: 'Date', value: r => r.ts },
  { key: 'actor', label: 'Acteur', value: r => r.actor },
  { key: 'action', label: 'Action', value: r => r.action },
  { key: 'outcome', label: 'Résultat', value: r => r.outcome },
  { key: 'targetType', label: 'Type d\'objet', value: r => r.targetType },
  { key: 'targetId', label: 'Objet', value: r => r.targetId },
  { key: 'ip', label: 'Adresse IP', value: r => r.ip },
  { key: 'details', label: 'Détails', value: r => r.details },
]

// ---------------------------------------------------------------------------
// Historique des images (Watchtower et changements hors plateforme)
// ---------------------------------------------------------------------------

export async function listImageUpdates(q: ImageUpdateListQuery, visibleTargets: string[] | null): Promise<Paginated<ImageUpdateRow>> {
  const u = schema.imageUpdates
  const where: (SQL | undefined)[] = [inList(u.targetId, visibleTargets)]
  const { from, to } = periodRange(q)
  if (from) where.push(gte(u.detectedAt, from))
  if (to) where.push(lte(u.detectedAt, to))
  if (q.kind?.length) where.push(inArray(u.kind, q.kind))
  if (q.projectId) where.push(eq(schema.projects.id, q.projectId))
  if (q.environmentId) where.push(eq(schema.environments.id, q.environmentId))
  if (q.q) where.push(or(ilike(u.service, `%${q.q}%`), ilike(u.image, `%${q.q}%`), ilike(schema.projects.name, `%${q.q}%`)))
  const cond = and(...where.filter(Boolean) as SQL[])
  const [sortKey, dir] = (q.sort ?? 'detectedAt:desc').split(':') as [string, 'asc' | 'desc']
  const SORT = { detectedAt: u.detectedAt, kind: u.kind, service: u.service, project: schema.projects.name } as const
  const col = SORT[sortKey as keyof typeof SORT] ?? u.detectedAt
  const from_ = () => db().select({ u, project: schema.projects.name, projectId: schema.projects.id, environment: schema.environments.name, release: schema.releases.number }).from(u)
    .innerJoin(schema.projectTargets, eq(schema.projectTargets.id, u.targetId))
    .innerJoin(schema.projects, eq(schema.projects.id, schema.projectTargets.projectId))
    .innerJoin(schema.environments, eq(schema.environments.id, schema.projectTargets.environmentId))
    .leftJoin(schema.releases, eq(schema.releases.id, u.releaseId))
  const [rows, [{ total }]] = await Promise.all([
    from_().where(cond).orderBy(order(dir, col)).limit(q.pageSize).offset((q.page - 1) * q.pageSize),
    db().select({ total: count() }).from(u)
      .innerJoin(schema.projectTargets, eq(schema.projectTargets.id, u.targetId))
      .innerJoin(schema.projects, eq(schema.projects.id, schema.projectTargets.projectId))
      .innerJoin(schema.environments, eq(schema.environments.id, schema.projectTargets.environmentId))
      .where(cond),
  ]) as [Awaited<ReturnType<ReturnType<typeof from_>['where']>>, [{ total: number }]]
  return {
    items: rows.map(r => ({
      id: r.u.id, detectedAt: r.u.detectedAt.toISOString(), kind: r.u.kind, service: r.u.service, image: r.u.image,
      fromImageId: r.u.fromImageId, toImageId: r.u.toImageId, digest: r.u.digest, detail: r.u.detail,
      project: r.project, projectId: r.projectId, environment: r.environment, releaseNumber: r.release,
    })),
    total, page: q.page, pageSize: q.pageSize,
  }
}

export const IMAGE_UPDATE_CSV: CsvColumn<ImageUpdateRow>[] = [
  { key: 'detectedAt', label: 'Date', value: r => r.detectedAt },
  { key: 'project', label: 'Projet', value: r => r.project },
  { key: 'environment', label: 'Environnement', value: r => r.environment },
  { key: 'service', label: 'Service', value: r => r.service },
  { key: 'kind', label: 'Évènement', value: r => r.kind },
  { key: 'image', label: 'Image', value: r => r.image },
  { key: 'fromImageId', label: 'Image avant', value: r => r.fromImageId },
  { key: 'toImageId', label: 'Image après', value: r => r.toImageId },
  { key: 'digest', label: 'Empreinte', value: r => r.digest },
  { key: 'releaseNumber', label: 'Release', value: r => r.releaseNumber },
  { key: 'detail', label: 'Détail', value: r => r.detail },
]
