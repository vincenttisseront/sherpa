import { eq, inArray, sql } from 'drizzle-orm'
import { createError } from 'h3'
import type { DeploymentDetailDto } from '../../shared/schemas/deployments'
import { db, schema } from '../db/client'
import { gateState } from './deploy-gate'

export type { DeploymentDetailDto }

/** Contexte RBAC d'un déploiement (projet, environnement, serveur). */
export async function deploymentScope(id: string) {
  const [row] = await db().select({ projectId: schema.projectTargets.projectId, environmentId: schema.projectTargets.environmentId, serverId: schema.serverEndpoints.serverId })
    .from(schema.deployments)
    .innerJoin(schema.projectTargets, eq(schema.projectTargets.id, schema.deployments.targetId))
    .innerJoin(schema.serverEndpoints, eq(schema.serverEndpoints.id, schema.projectTargets.endpointId))
    .where(eq(schema.deployments.id, id))
  if (!row) throw createError({ statusCode: 404, statusMessage: 'Déploiement introuvable' })
  return row
}

export async function loadDeploymentDetail(id: string): Promise<DeploymentDetailDto> {
  const [r] = await db().select({
    d: schema.deployments,
    p: { id: schema.projects.id, slug: schema.projects.slug, name: schema.projects.name },
    e: { key: schema.environments.key, name: schema.environments.name, isProduction: schema.environments.isProduction },
    s: { id: schema.portainerServers.id, name: schema.portainerServers.name },
    ep: { id: schema.serverEndpoints.id, name: schema.serverEndpoints.name },
    ackBy: schema.users.email,
    currentReleaseId: schema.projectTargets.currentReleaseId,
  })
    .from(schema.deployments)
    .innerJoin(schema.projectTargets, eq(schema.projectTargets.id, schema.deployments.targetId))
    .innerJoin(schema.projects, eq(schema.projects.id, schema.projectTargets.projectId))
    .innerJoin(schema.environments, eq(schema.environments.id, schema.projectTargets.environmentId))
    .innerJoin(schema.serverEndpoints, eq(schema.serverEndpoints.id, schema.projectTargets.endpointId))
    .innerJoin(schema.portainerServers, eq(schema.portainerServers.id, schema.serverEndpoints.serverId))
    .leftJoin(schema.users, eq(schema.users.id, schema.deployments.acknowledgedBy))
    .where(eq(schema.deployments.id, id))
  if (!r) throw createError({ statusCode: 404, statusMessage: 'Déploiement introuvable' })
  const emails = new Map((await db().select({ id: schema.users.id, email: schema.users.email }).from(schema.users).where(inArray(schema.users.id, [r.d.requestedBy, r.d.options.approval?.decidedBy].filter((x): x is string => !!x)))).map(u => [u.id, u.email]))
  const gate = gateState(r.d.options, r.d.requestedBy ? emails.get(r.d.requestedBy) ?? null : null, r.d.options.approval?.decidedBy ? emails.get(r.d.options.approval.decidedBy) ?? null : null)
  const [rel] = r.d.releaseId ? await db().select().from(schema.releases).where(eq(schema.releases.id, r.d.releaseId)) : []
  return {
    id: r.d.id,
    gate,
    status: r.d.status,
    action: r.d.action,
    error: r.d.error,
    failedFrom: r.d.failedFrom,
    acknowledged: r.d.acknowledgedAt ? { at: r.d.acknowledgedAt.toISOString(), by: r.ackBy } : null,
    statusDetails: await statusDetails(id),
    statusDurations: await statusDurations(id, r.d.finishedAt),
    createdAt: r.d.createdAt.toISOString(),
    startedAt: r.d.startedAt?.toISOString() ?? null,
    finishedAt: r.d.finishedAt?.toISOString() ?? null,
    project: r.p,
    environment: r.e,
    server: r.s,
    endpoint: r.ep,
    release: rel ? { id: rel.id, number: rel.number, slug: rel.slug, sourceKind: rel.sourceKind, archiveSha256: rel.archiveSha256, sourceTreeSha256: rel.sourceTreeSha256, remotePath: rel.remotePath, builds: ((rel.analysis as { builds?: unknown[] } | null)?.builds ?? []).length, commitSha: rel.commitSha, sourceRef: rel.sourceRef, current: rel.id === r.currentReleaseId } : null,
    options: { skipBuild: !!r.d.options?.skipBuild, cleanBuild: !!r.d.options?.cleanBuild, noPull: !!r.d.options?.noPull, upgrade: !!r.d.options?.upgrade },
  }
}

const STATUS_LINE = 'Statut : %'

/**
 * Temps passé dans chaque statut : de la ligne « Statut : X » à la suivante (la dernière va
 * jusqu'à la fin du déploiement, ou jusqu'à maintenant s'il est en cours).
 */
async function statusDurations(id: string, finishedAt: Date | null): Promise<Record<string, number>> {
  const rows = await db().execute<{ ts: Date | string, message: string }>(sql`
    select ts, message from deployment_logs where deployment_id = ${id} and phase = 'system' and message like ${STATUS_LINE} order by id`)
  const out: Record<string, number> = {}
  for (const [i, r] of [...rows].entries()) {
    const start = new Date(r.ts).getTime()
    const next = rows[i + 1] ? new Date(rows[i + 1]!.ts).getTime() : (finishedAt?.getTime() ?? Date.now())
    const status = r.message.slice(9)
    out[status] = (out[status] ?? 0) + Math.max(0, Math.round((next - start) / 1000))
  }
  return out
}

/**
 * Dernier message utile de chaque statut : les logs sont découpés par les
 * lignes « Statut : X » écrites à chaque transition (messages déjà masqués).
 */
async function statusDetails(id: string): Promise<DeploymentDetailDto['statusDetails']> {
  const rows = await db().execute<{ status: string, message: string, level: string }>(sql`
    with l as (
      select id, phase, level, message,
        sum(case when phase = 'system' and message like ${STATUS_LINE} then 1 else 0 end) over (order by id) as grp
      from deployment_logs where deployment_id = ${id}
    ), s as (
      select grp, substring(message from 10) as status from l where phase = 'system' and message like ${STATUS_LINE}
    )
    select distinct on (l.grp) s.status, l.message, l.level::text as level
    from l join s on s.grp = l.grp
    where l.level <> 'debug' and not (l.phase = 'system' and l.message like ${STATUS_LINE})
    order by l.grp, l.id desc`)
  const out: DeploymentDetailDto['statusDetails'] = {}
  for (const r of rows) out[r.status] = { message: r.message.length > 240 ? `${r.message.slice(0, 240)}…` : r.message, level: r.level }
  return out
}
