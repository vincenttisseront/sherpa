import { and, asc, count, desc, eq, gte, ilike, inArray, isNull, lte, or, sql, type SQL } from 'drizzle-orm'
import { runtimeState } from '../../shared/utils/target-state'
import { createError } from 'h3'
import type { Paginated, TableQuery } from '../../shared/schemas/common'
import { type DeployOption, type DeploymentListItem, type ProjectDto, type ProjectListItem, type TargetSummary, composeOverrides } from '../../shared/schemas/projects'
import { db, schema } from '../db/client'
import { periodRange } from '../utils/table'
import { projectLayout } from '../utils/path-guard'
import { resolvePending } from './pending'

export async function listProjects(q: TableQuery & { environmentId?: string, lastStatus?: string, archived?: 'all' | 'only' }, visible: string[] | null = null): Promise<Paginated<ProjectListItem>> {
  const p = schema.projects
  const where: SQL[] = q.archived === 'all' ? [] : [q.archived === 'only' ? sql`${p.archivedAt} is not null` : sql`${p.archivedAt} is null`]
  if (visible) where.push(visible.length ? inArray(p.id, visible) : sql`false`)
  if (q.q) where.push(or(ilike(p.name, `%${q.q}%`), ilike(p.slug, `%${q.q}%`))!)
  const { from, to } = periodRange(q)
  if (from) where.push(gte(p.createdAt, from))
  if (to) where.push(lte(p.createdAt, to))
  if (q.environmentId) where.push(sql`exists (select 1 from ${schema.projectTargets} pt where pt.project_id = ${p.id} and pt.environment_id = ${q.environmentId})`)
  if (q.lastStatus) {
    where.push(sql`(select d.status from ${schema.deployments} d join ${schema.projectTargets} pt on pt.id = d.target_id where pt.project_id = ${p.id} order by d.created_at desc limit 1) = ${q.lastStatus}`)
  }
  const [sortKey, dir] = (q.sort ?? 'name:asc').split(':') as [string, 'asc' | 'desc']
  const col = sortKey === 'createdAt' ? p.createdAt : sortKey === 'slug' ? p.slug : p.name
  const rows = await db().select().from(p).where(and(...where)).orderBy(dir === 'desc' ? desc(col) : asc(col)).limit(q.pageSize).offset((q.page - 1) * q.pageSize)
  const [{ total }] = await db().select({ total: count() }).from(p).where(and(...where)) as [{ total: number }]
  const ids = rows.map(r => r.id)
  const targets = ids.length ? await db().select({ id: schema.projectTargets.id, projectId: schema.projectTargets.projectId }).from(schema.projectTargets).where(inArray(schema.projectTargets.projectId, ids)) : []
  const last = targets.length
    ? await db().selectDistinctOn([schema.projectTargets.projectId], { projectId: schema.projectTargets.projectId, status: schema.deployments.status, at: schema.deployments.createdAt })
      .from(schema.deployments).innerJoin(schema.projectTargets, eq(schema.projectTargets.id, schema.deployments.targetId))
      .where(inArray(schema.projectTargets.projectId, ids))
      .orderBy(schema.projectTargets.projectId, desc(schema.deployments.createdAt))
    : []
  return {
    items: rows.map(r => ({
      id: r.id, slug: r.slug, name: r.name,
      targetCount: targets.filter(t => t.projectId === r.id).length,
      lastStatus: last.find(l => l.projectId === r.id)?.status ?? null,
      lastDeployedAt: last.find(l => l.projectId === r.id)?.at.toISOString() ?? null,
      createdAt: r.createdAt.toISOString(),
      archivedAt: r.archivedAt?.toISOString() ?? null,
    })),
    total, page: q.page, pageSize: q.pageSize,
  }
}

export async function loadProjectDetail(id: string): Promise<ProjectDto> {
  const [p] = await db().select().from(schema.projects).where(eq(schema.projects.id, id))
  if (!p) throw createError({ statusCode: 404, statusMessage: 'Projet introuvable' })
  const rows = await db().select({
    t: schema.projectTargets,
    e: { id: schema.environments.id, key: schema.environments.key, name: schema.environments.name, isProduction: schema.environments.isProduction, sortOrder: schema.environments.sortOrder },
    s: { id: schema.portainerServers.id, name: schema.portainerServers.name },
    ep: { id: schema.serverEndpoints.id, name: schema.serverEndpoints.name },
  }).from(schema.projectTargets)
    .innerJoin(schema.environments, eq(schema.environments.id, schema.projectTargets.environmentId))
    .innerJoin(schema.serverEndpoints, eq(schema.serverEndpoints.id, schema.projectTargets.endpointId))
    .innerJoin(schema.portainerServers, eq(schema.portainerServers.id, schema.serverEndpoints.serverId))
    .where(eq(schema.projectTargets.projectId, id))
    .orderBy(asc(schema.environments.sortOrder))
  const targets: TargetSummary[] = []
  for (const r of rows) {
    const [cur] = r.t.currentReleaseId ? await db().select().from(schema.releases).where(eq(schema.releases.id, r.t.currentReleaseId)) : []
    const [last] = await db().select().from(schema.deployments).where(eq(schema.deployments.targetId, r.t.id)).orderBy(desc(schema.deployments.createdAt)).limit(1)
    // Action en attente vérifiée à chaque lecture : levée si elle est faite.
    const pending = r.t.pendingAction ? await resolvePending(r.t.id) : null
    targets.push({
      id: r.t.id,
      environment: { id: r.e.id, key: r.e.key, name: r.e.name, isProduction: r.e.isProduction },
      server: r.s,
      endpoint: r.ep,
      stackName: r.t.stackName,
      projectPath: r.t.projectPath,
      volumesAsFolders: r.t.volumesAsFolders,
      proxyNetwork: r.t.proxyNetwork,
      layout: await layoutOf(r.t.endpointId, r.e.id, p.slug, r.t.projectPath),
      autoRollback: r.t.autoRollback,
      healthTimeoutSec: r.t.healthTimeoutSec,
      composeOverrides: composeOverrides.parse(r.t.composeOverrides ?? {}),
      pendingAction: r.t.pendingAction && pending && !pending.done ? { ...r.t.pendingAction, status: pending } : null,
      autoRebuild: r.t.autoRebuild ? { enabled: r.t.autoRebuild.enabled } : null,
      migratedFrom: r.t.migratedFrom && !r.t.migratedFrom.cleanedAt ? { serverName: r.t.migratedFrom.serverName, endpointName: r.t.migratedFrom.endpointName, stackName: r.t.migratedFrom.stackName, at: r.t.migratedFrom.at, volumes: r.t.migratedFrom.volumes, dataDir: r.t.migratedFrom.dataDir } : null,
      adoption: r.t.adoption ? { at: r.t.adoption.at, stack: r.t.adoption.stack, exposures: r.t.adoption.exposures, variables: r.t.adoption.variables } : null,
      currentRelease: cur ? { id: cur.id, number: cur.number, slug: cur.slug, activatedAt: cur.activatedAt?.toISOString() ?? null } : null,
      lastDeployment: last ? { id: last.id, action: last.action, status: last.status, createdAt: last.createdAt.toISOString(), finishedAt: last.finishedAt?.toISOString() ?? null } : null,
      state: runtimeState(last?.status, r.t.healthState, !!cur),
      failing: r.t.healthState?.failing.map(f => f.service) ?? [],
      healthCheckedAt: r.t.healthState?.checkedAt ?? null,
    })
  }
  return { id: p.id, slug: p.slug, name: p.name, description: p.description, createdAt: p.createdAt.toISOString(), archivedAt: p.archivedAt?.toISOString() ?? null, targets }
}

async function layoutOf(endpointId: string, environmentId: string, slug: string, projectPath: string | null): Promise<TargetSummary['layout']> {
  const [paths] = await db().select().from(schema.pathConfigs).where(and(eq(schema.pathConfigs.endpointId, endpointId), eq(schema.pathConfigs.environmentId, environmentId)))
  if (!paths) return null
  try {
    const l = projectLayout(paths, slug, projectPath)
    return { projectDir: l.projectDir, releasesDir: l.releasesDir, dataDir: l.runtimeDir }
  }
  catch {
    return null
  }
}

/** Endpoints où un projet peut être déployé, avec ce qui manque éventuellement. */
export async function deployOptions(): Promise<DeployOption[]> {
  const eps = await db().select({ ep: schema.serverEndpoints, s: { id: schema.portainerServers.id, name: schema.portainerServers.name } })
    .from(schema.serverEndpoints)
    .innerJoin(schema.portainerServers, eq(schema.portainerServers.id, schema.serverEndpoints.serverId))
    .where(and(eq(schema.serverEndpoints.enabled, true), eq(schema.serverEndpoints.missing, false)))
    .orderBy(asc(schema.portainerServers.name), asc(schema.serverEndpoints.name))
  const out: DeployOption[] = []
  for (const { ep, s } of eps) {
    const envs = await db().select({ id: schema.environments.id, key: schema.environments.key, name: schema.environments.name, isProduction: schema.environments.isProduction })
      .from(schema.endpointEnvironments).innerJoin(schema.environments, eq(schema.environments.id, schema.endpointEnvironments.environmentId))
      .where(eq(schema.endpointEnvironments.endpointId, ep.id)).orderBy(asc(schema.environments.sortOrder))
    const paths = await db().select({ environmentId: schema.pathConfigs.environmentId, workingRoot: schema.pathConfigs.workingRoot, runtimeRoot: schema.pathConfigs.runtimeRoot }).from(schema.pathConfigs).where(eq(schema.pathConfigs.endpointId, ep.id))
    const [runner] = await db().select().from(schema.targetRunners).where(eq(schema.targetRunners.endpointId, ep.id))
    const nets = await db().select({ name: schema.networks.name, role: schema.networks.role }).from(schema.networks)
      .where(and(eq(schema.networks.endpointId, ep.id), eq(schema.networks.policy, 'allowed'), eq(schema.networks.missing, false)))
    const [tc] = await db().select({ networkName: schema.traefikConfigs.networkName }).from(schema.traefikConfigs).where(and(eq(schema.traefikConfigs.endpointId, ep.id), isNull(schema.traefikConfigs.environmentId)))
    const [mp] = await db().select({ applied: schema.managedProxies.appliedConfig }).from(schema.managedProxies).where(eq(schema.managedProxies.endpointId, ep.id))
    const managedNets = new Set(mp?.applied?.networks ?? [])
    out.push({
      endpointId: ep.id,
      endpointName: ep.name,
      serverId: s.id,
      serverName: s.name,
      environments: envs.map((e) => {
        const p = paths.find(x => x.environmentId === e.id)
        return { id: e.id, key: e.key, name: e.name, isProduction: e.isProduction, pathsConfigured: !!p, roots: p ? { workingRoot: p.workingRoot, runtimeRoot: p.runtimeRoot } : null }
      }),
      runner: { status: runner?.status ?? 'unconfigured', build: null },
      proxyNetworks: nets
        .map(n => ({ name: n.name, role: n.role, managed: managedNets.has(n.name), default: n.name === tc?.networkName }))
        .sort((a, b) => Number(b.default) - Number(a.default) || Number(b.managed) - Number(a.managed) || Number(b.role === 'traefik') - Number(a.role === 'traefik') || a.name.localeCompare(b.name)),
      managedProxy: mp?.applied ? { acme: mp.applied.acme.enabled, resolver: mp.applied.acme.enabled ? 'le' : null } : null,
    })
  }
  return out
}

export async function listTargetDeployments(targetId: string, page: number, pageSize: number): Promise<Paginated<DeploymentListItem>> {
  const d = schema.deployments
  const rows = await db().select({ d, number: schema.releases.number, email: schema.users.email })
    .from(d).leftJoin(schema.releases, eq(schema.releases.id, d.releaseId)).leftJoin(schema.users, eq(schema.users.id, d.requestedBy))
    .where(eq(d.targetId, targetId)).orderBy(desc(d.createdAt)).limit(pageSize).offset((page - 1) * pageSize)
  const [{ total }] = await db().select({ total: count() }).from(d).where(eq(d.targetId, targetId)) as [{ total: number }]
  return {
    items: rows.map(r => ({ id: r.d.id, action: r.d.action, status: r.d.status, releaseNumber: r.number, requestedBy: r.email, createdAt: r.d.createdAt.toISOString(), finishedAt: r.d.finishedAt?.toISOString() ?? null, error: r.d.error })),
    total, page, pageSize,
  }
}
