/**
 * Historique des ressources des conteneurs déployés par la plateforme (CPU, mémoire, redémarrages) : un relevé par minute
 * par le worker, conservé METRICS_RETENTION_DAYS jours, et règles d'alerte évaluées à chaque relevé (notification
 * `resource.alert` au franchissement du seuil, puis au retour à la normale).
 */
import { and, desc, eq, gte, inArray, isNull, sql } from 'drizzle-orm'
import { DEFAULT_METRIC_RULES, METRIC_LABEL, METRIC_RANGES, type ActiveAlertDto, type MetricAlertsDto, type MetricPoint, type MetricRange, type MetricRule, type MetricsDto, metricRule } from '../../shared/schemas/metrics'
import { portainer } from '../adapters/portainer'
import { db, schema } from '../db/client'
import { type Sample, evaluateRule } from '../lib/metric-rules'
import { redis } from '../queue/redis'
import { env } from '../utils/env'
import { mapLimit } from '../utils/pool'
import { type EndpointRow, scanEndpoint } from './live'
import { emitNotification } from './notifications'
import { connectionFor } from './servers'

const RULES_KEY = 'metric-alert-rules'
const CONCURRENCY = 6

export async function getRules(): Promise<MetricRule[]> {
  const [row] = await db().select().from(schema.appSettings).where(eq(schema.appSettings.key, RULES_KEY))
  const rules = (row?.value as { rules?: unknown[] } | undefined)?.rules
  if (!Array.isArray(rules)) return DEFAULT_METRIC_RULES
  return rules.flatMap((r) => { const p = metricRule.safeParse(r); return p.success ? [p.data] : [] })
}

export async function setRules(rules: MetricRule[], userId: string | null): Promise<void> {
  await db().insert(schema.appSettings).values({ key: RULES_KEY, value: { rules }, updatedBy: userId })
    .onConflictDoUpdate({ target: schema.appSettings.key, set: { value: { rules }, updatedBy: userId, updatedAt: new Date() } })
}

async function endpointRows(): Promise<EndpointRow[]> {
  return db().select({ ep: schema.serverEndpoints, server: schema.portainerServers }).from(schema.serverEndpoints)
    .innerJoin(schema.portainerServers, eq(schema.portainerServers.id, schema.serverEndpoints.serverId))
    .where(and(eq(schema.serverEndpoints.enabled, true), eq(schema.serverEndpoints.missing, false)))
}

interface Tracked { endpointId: string, container: string, stack: string | null, id: string, row: EndpointRow }

/** Un relevé de tous les conteneurs en marche déployés par la plateforme, puis évaluation des règles. */
export async function sampleAll(): Promise<{ containers: number, alerts: number }> {
  // Un seul relevé à la fois, même si le précédent a débordé sur la minute suivante.
  if (!(await redis().set('metrics:sampling', '1', 'EX', 55, 'NX'))) return { containers: 0, alerts: 0 }
  const rows = await endpointRows()
  const tracked: Tracked[] = []
  for (const row of rows) {
    const snap = await scanEndpoint(row)
    if (!snap.ok) continue
    for (const c of snap.containers) if (c.managed && c.state === 'running') tracked.push({ endpointId: row.ep.id, container: c.name, stack: c.stack, id: c.id, row })
  }
  const now = new Date()
  const conns = new Map<string, Awaited<ReturnType<typeof connectionFor>>>()
  const values = (await mapLimit(tracked, CONCURRENCY, async (t) => {
    try {
      let conn = conns.get(t.row.server.id)
      if (!conn) { conn = await connectionFor(t.row.server); conns.set(t.row.server.id, conn) }
      const p = portainer()
      const [stats, detail] = await Promise.all([p.containerStats(conn, t.row.ep.portainerEndpointId, t.id), p.inspectContainer(conn, t.row.ep.portainerEndpointId, t.id)])
      if (!stats) return null
      return { ts: now, endpointId: t.endpointId, container: t.container, cpuPercent: stats.cpuPercent, memoryBytes: stats.memoryBytes, memoryLimitBytes: stats.memoryLimitBytes, restartCount: detail?.restartCount ?? null }
    }
    catch {
      return null
    }
  })).filter((v): v is NonNullable<typeof v> => v !== null)
  if (values.length) await db().insert(schema.containerMetrics).values(values)
  const alerts = await evaluateAlerts(tracked, now)
  // Purge horaire des relevés expirés.
  if (await redis().set('metrics:purge', '1', 'EX', 3600, 'NX')) {
    await db().delete(schema.containerMetrics).where(sql`${schema.containerMetrics.ts} < now() - make_interval(days => ${env().METRICS_RETENTION_DAYS})`)
    await db().delete(schema.metricAlerts).where(sql`${schema.metricAlerts.resolvedAt} < now() - make_interval(days => ${env().METRICS_RETENTION_DAYS})`)
  }
  return { containers: values.length, alerts }
}

async function evaluateAlerts(tracked: Tracked[], now: Date): Promise<number> {
  const rules = (await getRules()).filter(r => r.enabled)
  const active = await db().select().from(schema.metricAlerts).where(isNull(schema.metricAlerts.resolvedAt))
  if (!rules.length && !active.length) return 0
  const maxMin = Math.max(0, ...rules.map(r => r.minutes))
  const from = new Date(now.getTime() - maxMin * 60_000)
  const endpointIds = [...new Set(tracked.map(t => t.endpointId))]
  const samples = endpointIds.length && maxMin
    ? await db().select().from(schema.containerMetrics).where(and(inArray(schema.containerMetrics.endpointId, endpointIds), gte(schema.containerMetrics.ts, from)))
    : []
  const by = new Map<string, Sample[]>()
  for (const s of samples) {
    const k = `${s.endpointId}|${s.container}`
    by.set(k, [...(by.get(k) ?? []), { ts: s.ts.getTime(), cpu: s.cpuPercent, memory: s.memoryBytes, memoryLimit: s.memoryLimitBytes, restarts: s.restartCount }])
  }
  const activeKey = (a: { endpointId: string, container: string, ruleId: string }) => `${a.endpointId}|${a.container}|${a.ruleId}`
  const activeMap = new Map(active.map(a => [activeKey(a), a]))
  let changes = 0
  const seen = new Set<string>()
  for (const t of tracked) {
    const ctx = await contextOf(t)
    for (const rule of rules) {
      const key = activeKey({ endpointId: t.endpointId, container: t.container, ruleId: rule.id })
      seen.add(key)
      const r = evaluateRule(rule, by.get(`${t.endpointId}|${t.container}`) ?? [], now.getTime())
      const current = activeMap.get(key)
      if (r.firing && !current) {
        const [row] = await db().insert(schema.metricAlerts).values({ endpointId: t.endpointId, container: t.container, ruleId: rule.id, ruleName: rule.name, metric: rule.metric, threshold: rule.threshold, value: r.value, projectId: ctx.projectId, environmentId: ctx.environmentId, since: now }).onConflictDoNothing().returning({ id: schema.metricAlerts.id })
        if (row) {
          changes++
          await notify('fired', rule, t, ctx, r.value)
        }
      }
      else if (!r.firing && current) {
        await db().update(schema.metricAlerts).set({ resolvedAt: now, value: r.value ?? current.value }).where(eq(schema.metricAlerts.id, current.id))
        changes++
        await notify('resolved', rule, t, ctx, r.value)
      }
    }
  }
  // Conteneur disparu (arrêté, supprimé) ou règle retirée : alerte close sans bruit.
  const ruleIds = new Set(rules.map(r => r.id))
  for (const a of active) {
    if (!seen.has(activeKey(a)) || !ruleIds.has(a.ruleId)) await db().update(schema.metricAlerts).set({ resolvedAt: now }).where(eq(schema.metricAlerts.id, a.id))
  }
  return changes
}

interface Ctx { projectId: string | null, project: string | null, environmentId: string | null, environment: string | null, serverId: string, serverName: string }
const ctxCache = new Map<string, { at: number, v: Ctx }>()
async function contextOf(t: Tracked): Promise<Ctx> {
  const key = `${t.endpointId}|${t.stack ?? ''}`
  const hit = ctxCache.get(key)
  if (hit && Date.now() - hit.at < 5 * 60_000) return hit.v
  const [x] = t.stack
    ? await db().select({ projectId: schema.projects.id, project: schema.projects.name, environmentId: schema.environments.id, environment: schema.environments.name }).from(schema.projectTargets)
        .innerJoin(schema.projects, eq(schema.projects.id, schema.projectTargets.projectId))
        .innerJoin(schema.environments, eq(schema.environments.id, schema.projectTargets.environmentId))
        .where(and(eq(schema.projectTargets.endpointId, t.endpointId), eq(schema.projectTargets.stackName, t.stack)))
    : []
  const v: Ctx = { projectId: x?.projectId ?? null, project: x?.project ?? null, environmentId: x?.environmentId ?? null, environment: x?.environment ?? null, serverId: t.row.server.id, serverName: t.row.server.name }
  ctxCache.set(key, { at: Date.now(), v })
  return v
}

async function notify(kind: 'fired' | 'resolved', rule: MetricRule, t: Tracked, c: Ctx, value: number | null) {
  const m = METRIC_LABEL[rule.metric]
  const shown = value === null ? 'n/d' : `${Math.round(value * 10) / 10} ${m.unit === '%' ? '%' : ''}`.trim()
  const where = c.project ? `${c.project} (${c.environment})` : t.container
  await emitNotification({
    event: 'resource.alert',
    severity: kind === 'fired' ? 'warning' : 'info',
    title: kind === 'fired' ? `${rule.name} : ${t.container}` : `Rétabli — ${rule.name} : ${t.container}`,
    summary: kind === 'fired'
      ? `${t.container} (${where}) : ${m.name.toLowerCase()} ${rule.metric === 'restarts' ? `${shown} redémarrage(s)` : `à ${shown}`} depuis ${rule.minutes} min (seuil ${rule.threshold}${m.unit === '%' ? ' %' : ''}).`
      : `${t.container} (${where}) : ${m.name.toLowerCase()} revenu sous le seuil (${rule.threshold}${m.unit === '%' ? ' %' : ''}).`,
    facts: [{ label: 'Conteneur', value: t.container }, ...(c.project ? [{ label: 'Projet', value: c.project }, { label: 'Environnement', value: c.environment ?? '' }] : []), { label: 'Serveur', value: c.serverName }, { label: 'Valeur', value: shown }, { label: 'Seuil', value: `${rule.threshold}${m.unit === '%' ? ' %' : ''} sur ${rule.minutes} min` }],
    path: c.projectId ? `/projects/${c.projectId}` : '/containers',
    serverId: c.serverId, environmentId: c.environmentId, projectId: c.projectId,
  })
}

// --- Lecture ---

/** Historique d'un conteneur (par nom), regroupé en ≤ ~170 points : CPU moyen, mémoire maximale, redémarrages cumulés. */
export async function metricsFor(endpointId: string, container: string, range: MetricRange): Promise<MetricsDto> {
  const minutes = METRIC_RANGES[range]
  const bucketMin = Math.max(1, Math.ceil(minutes / 170))
  const rows = await db().execute(sql`
    select date_bin(make_interval(mins => ${bucketMin}), ts, timestamptz '2000-01-01') as t,
      avg(cpu_percent)::float8 as cpu, max(memory_bytes)::float8 as memory, max(memory_limit_bytes)::float8 as memory_limit, max(restart_count)::int as restarts
    from container_metrics
    where endpoint_id = ${endpointId} and container = ${container} and ts >= now() - make_interval(mins => ${minutes})
    group by 1 order by 1`) as unknown as { t: Date | string, cpu: number | null, memory: number | null, memory_limit: number | null, restarts: number | null }[]
  const points: MetricPoint[] = rows.map(r => ({ t: new Date(r.t).toISOString(), cpu: r.cpu === null ? null : Math.round(r.cpu * 10) / 10, memory: r.memory, memoryLimit: r.memory_limit, restarts: r.restarts }))
  const alerts = await alertRows(and(eq(schema.metricAlerts.endpointId, endpointId), eq(schema.metricAlerts.container, container), isNull(schema.metricAlerts.resolvedAt)))
  return { range, container, tracked: points.length > 0, points, alerts }
}

async function alertRows(where: ReturnType<typeof and>, limit = 50): Promise<ActiveAlertDto[]> {
  const rows = await db().select({ a: schema.metricAlerts, project: schema.projects.name, environment: schema.environments.name }).from(schema.metricAlerts)
    .leftJoin(schema.projects, eq(schema.projects.id, schema.metricAlerts.projectId))
    .leftJoin(schema.environments, eq(schema.environments.id, schema.metricAlerts.environmentId))
    .where(where).orderBy(desc(schema.metricAlerts.since)).limit(limit)
  return rows.map(r => ({ id: r.a.id, rule: r.a.ruleName, metric: r.a.metric as ActiveAlertDto['metric'], container: r.a.container, project: r.project, environment: r.environment, value: r.a.value, threshold: r.a.threshold, since: r.a.since.toISOString(), resolvedAt: r.a.resolvedAt?.toISOString() ?? null }))
}

export async function alertsOverview(): Promise<MetricAlertsDto> {
  const [last] = await db().select({ ts: sql<Date | null>`max(${schema.containerMetrics.ts})`, n: sql<number>`count(distinct (${schema.containerMetrics.endpointId}, ${schema.containerMetrics.container}))::int` }).from(schema.containerMetrics).where(sql`${schema.containerMetrics.ts} > now() - interval '10 minutes'`)
  return {
    rules: await getRules(),
    active: await alertRows(isNull(schema.metricAlerts.resolvedAt)),
    recent: await alertRows(sql`${schema.metricAlerts.resolvedAt} is not null`, 20),
    samples: { containers: last?.n ?? 0, lastAt: last?.ts ? new Date(last.ts).toISOString() : null },
  }
}
