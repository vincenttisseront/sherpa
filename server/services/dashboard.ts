/**
 * Tableau de bord (§17) : données des agents (statut des serveurs, endpoints,
 * santé observée des stacks) et données internes (déploiements, audit, alertes,
 * Watchtower), restreintes aux portées de l'utilisateur.
 */
import { and, count, desc, eq, gte, inArray, isNull, sql, type SQL } from 'drizzle-orm'
import { PERIOD_MS, type Period } from '../../shared/schemas/common'
import type { DashboardDto, PendingItem, TargetHealthState } from '../../shared/schemas/dashboard'
import { RESERVED_TLD } from '../../shared/schemas/managed-proxy'
import { ACTIVE_STATUSES, type DeploymentStatus, FAILED_STATUSES } from '../../shared/utils/deployment-status'
import { runtimeState } from '../../shared/utils/target-state'
import { db, schema } from '../db/client'
import { type AuthUser, canOn } from '../utils/auth'
import { visibleProjectIds, visibleServerIds, visibleTargetIds } from './access'
import { lastActivationAt, variablesNotDeployed } from './projects'
import { effectiveWatchtowerImage, engineOutdated } from './update-engine'
import { resolvePending } from './pending'
import { listCertificates } from './proxy-certificates'
import { buildProxyGraph } from '../../shared/utils/proxy-graph'
import { endpointProxyMap } from './proxy-map'
import { type DetectedUrl, linksOf } from './dashboard-links'

const within = <T>(col: Parameters<typeof inArray>[0], ids: T[] | null): SQL | undefined => (ids === null ? undefined : ids.length ? inArray(col, ids as never[]) : sql`false`)

/**
 * Routes des reverse proxies de chaque endpoint (Traefik, Caddy, nginx…) vers les stacks :
 * carte des proxies en cache ; une lecture plus lente que 2 s est ignorée (elle remplit le cache).
 */
async function detectedUrls(endpointIds: string[]): Promise<Map<string, DetectedUrl[]>> {
  const ids = [...new Set(endpointIds)]
  const out = new Map<string, DetectedUrl[]>()
  if (!ids.length) return out
  const rows = await db().select({ ep: schema.serverEndpoints, server: schema.portainerServers }).from(schema.serverEndpoints)
    .innerJoin(schema.portainerServers, eq(schema.portainerServers.id, schema.serverEndpoints.serverId))
    .where(inArray(schema.serverEndpoints.id, ids))
  await Promise.all(rows.map(async (row) => {
    const map = await Promise.race([
      endpointProxyMap(row).catch(() => null),
      new Promise<null>(r => setTimeout(() => r(null), 2000)),
    ])
    if (!map) return
    const graph = buildProxyGraph(map, { showDirect: false, showUnrouted: false })
    const urls: DetectedUrl[] = []
    for (const u of graph.urls) {
      if (u.redirect) continue
      const route = map.topology.routes[u.indexes[0]!]
      for (const s of u.stacks) urls.push({ stack: s.replace(/^stack:/, ''), host: `${u.host}${u.path ?? ''}`, url: u.url, service: route?.container?.service ?? null })
    }
    out.set(row.ep.id, urls)
  }))
  return out
}

export async function loadDashboard(user: AuthUser, period: Period): Promise<DashboardDto> {
  const since = new Date(Date.now() - PERIOD_MS[period])
  const [servers, targets, projects] = await Promise.all([
    visibleServerIds(user, 'server:read'),
    visibleTargetIds(user, 'deployment:read'),
    visibleProjectIds(user, 'project:read'),
  ])
  const d = schema.deployments
  const pt = schema.projectTargets

  const serverRows = await db().select({ status: schema.portainerServers.status }).from(schema.portainerServers).where(within(schema.portainerServers.id, servers))
  const endpointRows = await db().select({ missing: schema.serverEndpoints.missing, enabled: schema.serverEndpoints.enabled, status: schema.portainerServers.status })
    .from(schema.serverEndpoints).innerJoin(schema.portainerServers, eq(schema.portainerServers.id, schema.serverEndpoints.serverId))
    .where(within(schema.serverEndpoints.serverId, servers))
  const engineImage = await effectiveWatchtowerImage()
  const targetRows = await db().select({
    id: pt.id, projectId: pt.projectId, health: pt.healthState, current: pt.currentReleaseId, project: schema.projects.name, environment: schema.environments.name,
    isProduction: schema.environments.isProduction, server: schema.portainerServers.name, exposures: pt.exposures, watchtower: pt.watchtowerApplied, watchtowerWanted: pt.watchtower, watchtowerImage: pt.watchtowerImageApplied,
    endpointId: pt.endpointId, proxyNetwork: pt.proxyNetwork, pendingAction: pt.pendingAction, variablesMeta: pt.variablesMeta, stackName: pt.stackName, slug: schema.projects.slug, envKey: schema.environments.key,
  }).from(pt)
    .innerJoin(schema.projects, eq(schema.projects.id, pt.projectId))
    .innerJoin(schema.environments, eq(schema.environments.id, pt.environmentId))
    .innerJoin(schema.serverEndpoints, eq(schema.serverEndpoints.id, pt.endpointId))
    .innerJoin(schema.portainerServers, eq(schema.portainerServers.id, schema.serverEndpoints.serverId))
    .where(and(within(pt.id, targets), sql`${schema.projects.archivedAt} is null`))

  const inPeriod = and(within(d.targetId, targets), gte(d.createdAt, since))
  const [byStatus, running, buildsFailed, failedOpen] = await Promise.all([
    db().select({ status: d.status, n: count() }).from(d).where(and(inPeriod, inArray(d.action, ['deploy', 'redeploy', 'rollback']))).groupBy(d.status),
    db().select({ n: count() }).from(d).where(and(within(d.targetId, targets), inArray(d.status, [...ACTIVE_STATUSES]))),
    db().select({ n: count() }).from(d).where(and(inPeriod, eq(d.status, 'FAILED'), eq(d.failedFrom, 'BUILDING'), isNull(d.acknowledgedAt))),
    db().select({ n: count() }).from(d).where(and(inPeriod, inArray(d.action, ['deploy', 'redeploy', 'rollback']), inArray(d.status, [...FAILED_STATUSES]), isNull(d.acknowledgedAt))),
  ])
  const n = (s: string[]) => byStatus.filter(b => s.includes(b.status)).reduce((a, b) => a + b.n, 0)

  // Cibles dont la dernière opération ou le dernier constat de santé est mauvais.
  const lastStatus = targetRows.length
    ? await db().selectDistinctOn([d.targetId], { targetId: d.targetId, status: d.status, id: d.id, at: d.createdAt, acknowledgedAt: d.acknowledgedAt }).from(d).where(inArray(d.targetId, targetRows.map(t => t.id))).orderBy(d.targetId, desc(d.createdAt))
    : []
  const degraded: DashboardDto['degraded'] = []
  let unhealthyServices = 0
  for (const t of targetRows) {
    const h = t.health as TargetHealthState | null
    const last = lastStatus.find(l => l.targetId === t.id)?.status
    if (!t.current && last !== 'FAILED') continue
    // La santé constatée fait foi ; à défaut, le dernier déploiement (un échec avec une release
    // précédente toujours active n'est pas une dégradation : il est compté dans les échecs).
    const bad = h ? h.status !== 'healthy' : last === 'DEGRADED' || (last === 'FAILED' && !t.current)
    if (h) unhealthyServices += h.failing.length
    if (bad) degraded.push({ targetId: t.id, projectId: t.projectId, project: t.project, environment: t.environment, status: h && h.status !== 'healthy' ? h.status : (last ?? 'unknown').toLowerCase(), failing: h?.failing.map(f => f.service) ?? [], checkedAt: h?.checkedAt ?? null })
  }

  // Ce qui est déployé : release active (source, images), domaines, santé constatée, dernière opération.
  const releaseIds = targetRows.map(t => t.current).filter((x): x is string => !!x)
  const releases = releaseIds.length
    ? await db().select({ r: schema.releases, archive: schema.uploads.originalName }).from(schema.releases)
      .leftJoin(schema.uploads, eq(schema.uploads.id, schema.releases.uploadId))
      .where(inArray(schema.releases.id, releaseIds))
    : []
  // Port HTTPS public : celui du Traefik géré quand il sert la cible (réseau du proxy), sinon 443.
  const managed = targetRows.length
    ? await db().select({ endpointId: schema.managedProxies.endpointId, applied: schema.managedProxies.appliedConfig }).from(schema.managedProxies).where(inArray(schema.managedProxies.endpointId, [...new Set(targetRows.map(t => t.endpointId))]))
    : []
  const httpsPortOf = (t: (typeof targetRows)[number]) => {
    const m = managed.find(x => x.endpointId === t.endpointId)?.applied
    return m && (t.proxyNetwork ? m.networks.includes(t.proxyNetwork) : true) ? m.httpsPort : 443
  }
  const detected = await detectedUrls(targetRows.filter(t => t.current).map(t => t.endpointId))
  const deployed: DashboardDto['deployed'] = []
  for (const t of targetRows) {
    const last = lastStatus.find(l => l.targetId === t.id)
    const running = !!last && (ACTIVE_STATUSES as readonly string[]).includes(last.status)
    if (!t.current && !running) continue
    const rel = releases.find(x => x.r.id === t.current)
    const h = t.health as TargetHealthState | null
    // Arrêt demandé : l'état de santé enregistré avant l'arrêt n'a plus cours.
    const status: DashboardDto['deployed'][number]['status'] = running ? 'deploying' : runtimeState(last?.status, h, !!t.current)
    const source = !rel
      ? '—'
      : rel.r.sourceKind === 'github'
        ? `${rel.r.repository ?? 'GitHub'}@${rel.r.sourceRef ?? rel.r.commitSha?.slice(0, 7) ?? '?'}`
        : rel.archive ?? 'Archive'
    deployed.push({
      targetId: t.id,
      projectId: t.projectId,
      project: t.project,
      environment: t.environment,
      isProduction: t.isProduction,
      server: t.server,
      status,
      failing: h?.failing.map(f => f.service) ?? [],
      release: rel ? { number: rel.r.number, activatedAt: rel.r.activatedAt?.toISOString() ?? null, source } : null,
      lastDeployment: last ? { id: last.id, status: last.status, at: last.at.toISOString() } : null,
      images: [...new Set(Object.values(rel?.r.images ?? {}).map(i => i.replace(/^docker\.io\/(library\/)?/, '')))].sort(),
      links: linksOf(t, httpsPortOf(t), detected.get(t.endpointId) ?? []),
      watchtower: !!t.watchtower,
      watchtowerToApply: !!watchtowerToApply(t, engineImage),
    })
  }
  deployed.sort((a, b) => Number(b.isProduction) - Number(a.isProduction) || a.project.localeCompare(b.project) || a.environment.localeCompare(b.environment))

  const pending = await pendingItems(user, targetRows, lastStatus, servers, engineImage)

  const auditVisible = canOn(user, 'audit:read', {})
  const recentActions = auditVisible || projects
    ? await db().select().from(schema.auditEvents)
      .where(and(
        auditVisible ? undefined : (projects!.length ? inArray(schema.auditEvents.projectId, projects!) : sql`false`),
        sql`${schema.auditEvents.actorLabel} <> 'system'`,
      ))
      .orderBy(desc(schema.auditEvents.ts)).limit(10)
    : []
  const ne = schema.notificationEvents
  const recentAlerts = await db().select().from(ne)
    .where(and(
      inArray(ne.severity, ['warning', 'error']),
      // Droits et invitations : sujets d'administration.
      canOn(user, 'user:manage', {}) || canOn(user, 'role:manage', {}) ? undefined : sql`${ne.event} not in ('permissions.changed', 'user.invited')`,
      projects === null ? undefined : or_(projects.length ? inArray(ne.projectId, projects) : sql`false`, servers === null ? sql`${ne.projectId} is null` : and(sql`${ne.projectId} is null`, servers.length ? inArray(ne.serverId, servers) : sql`false`)),
      // Alertes d'un déploiement dont l'échec a été acquitté : retirées.
      sql`not exists (select 1 from ${d} where ${d.acknowledgedAt} is not null and ${ne.link} like '%/deployments/' || ${d.id}::text)`))
    .orderBy(desc(ne.createdAt)).limit(10)
  const iu = schema.imageUpdates
  const updates = await db().select({ u: iu, project: schema.projects.name, projectId: schema.projects.id, environment: schema.environments.name }).from(iu)
    .innerJoin(pt, eq(pt.id, iu.targetId))
    .innerJoin(schema.projects, eq(schema.projects.id, pt.projectId))
    .innerJoin(schema.environments, eq(schema.environments.id, pt.environmentId))
    .where(and(within(iu.targetId, targets), gte(iu.detectedAt, since)))
    .orderBy(desc(iu.detectedAt)).limit(10)
  const [{ updatesCount }] = await db().select({ updatesCount: count() }).from(iu).where(and(within(iu.targetId, targets), gte(iu.detectedAt, since), inArray(iu.kind, ['updated', 'external']))) as [{ updatesCount: number }]

  // Activité quotidienne (heure de Paris).
  const day = sql<string>`to_char(${d.createdAt} at time zone 'Europe/Paris', 'YYYY-MM-DD')`
  const activityRows = await db().select({ day, status: d.status, n: count() }).from(d)
    .where(and(inPeriod, inArray(d.action, ['deploy', 'redeploy', 'rollback']), inArray(d.status, ['HEALTHY', 'DEGRADED', 'FAILED', 'ROLLED_BACK', 'VALIDATION_FAILED']))).groupBy(day, d.status)
  const days = Math.min(Math.ceil(PERIOD_MS[period] / 864e5), 183)
  const fmtDay = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/Paris' })
  const activity = Array.from({ length: days }, (_, i) => fmtDay.format(new Date(Date.now() - (days - 1 - i) * 864e5))).map(dd => ({
    day: dd,
    succeeded: activityRows.filter(r => r.day === dd && r.status === 'HEALTHY').reduce((a, b) => a + b.n, 0),
    failed: activityRows.filter(r => r.day === dd && r.status !== 'HEALTHY' && r.status !== 'DEGRADED').reduce((a, b) => a + b.n, 0),
  }))

  return {
    period,
    tiles: {
      serversOnline: serverRows.filter(s => s.status === 'online').length,
      serversTotal: serverRows.length,
      endpointsReachable: endpointRows.filter(e => e.enabled && !e.missing && (e.status === 'online' || e.status === 'degraded')).length,
      endpointsTotal: endpointRows.length,
      activeProjects: new Set(targetRows.filter(t => t.current).map(t => t.projectId)).size,
      deploymentsRunning: running[0]!.n,
      deploymentsSucceeded: n(['HEALTHY']),
      // Échecs non acquittés.
      deploymentsFailed: failedOpen[0]!.n,
      buildsFailed: buildsFailed[0]!.n,
      degradedTargets: degraded.length,
      unhealthyServices,
      imageUpdates: updatesCount,
    },
    deployed,
    pending,
    watchtower: { enabled: deployed.filter(x => x.watchtower).length, toApply: deployed.filter(x => x.watchtowerToApply).length, deployed: deployed.length },
    degraded,
    recentActions: recentActions.map(a => ({ id: String(a.id), at: a.ts.toISOString(), actor: a.actorLabel, action: a.action, outcome: a.outcome, target: a.targetType ? `${a.targetType}` : null })),
    recentAlerts: recentAlerts.map((a) => {
      const link = a.link ? new URL(a.link).pathname : null
      return { id: a.id, at: a.createdAt.toISOString(), event: a.event, severity: a.severity, title: a.title, link, deploymentId: /^\/deployments\/([0-9a-f-]{36})$/.exec(link ?? '')?.[1] ?? null }
    }),
    imageUpdates: updates.map(u => ({ id: u.u.id, at: u.u.detectedAt.toISOString(), project: u.project, projectId: u.projectId, environment: u.environment, service: u.u.service, kind: u.u.kind })),
    activity,
  }
}

type TargetRowLite = { id: string, projectId: string, project: string, environment: string, current: string | null, pendingAction: { title: string, at: string } | null, watchtower: unknown, watchtowerWanted: unknown, watchtowerImage: string | null, variablesMeta: Record<string, { updatedAt: string }> | null }

/**
 * Watchtower activé mais pas en place tel que voulu (le sidecar n'est posé ou mis à jour qu'au
 * déploiement) : absent, configuration modifiée, ou autre image que celle choisie par l'administration.
 */
function watchtowerToApply(t: { watchtower: unknown, watchtowerWanted: unknown, watchtowerImage: string | null }, engineImage: string): 'missing' | 'config' | 'image' | null {
  const wanted = t.watchtowerWanted as { enabled?: boolean } | null
  if (!wanted?.enabled) return null
  if (!t.watchtower) return 'missing'
  if (JSON.stringify(t.watchtower) !== JSON.stringify(wanted)) return 'config'
  return engineOutdated(t.watchtowerImage, engineImage) ? 'image' : null
}
const TO_APPLY_DETAIL = { missing: 'Watchtower activé mais pas en place', config: 'Configuration Watchtower modifiée', image: 'Nouvelle image du moteur de mise à jour' } as const
type LastLite = { targetId: string, status: string, id: string, at: Date, acknowledgedAt: Date | null }

/**
 * Ce qui reste à faire : actions déclarées sur les cibles, cibles arrêtées ou en échec,
 * jamais déployées, archives importées non déployées (purgées après 24 h), configuration
 * ACME refusée par Let's Encrypt, réseaux à revoir. Ordre : danger, avertissement, information.
 */
async function pendingItems(user: AuthUser, targetRows: TargetRowLite[], lastStatus: LastLite[], servers: string[] | null, engineImage: string): Promise<PendingItem[]> {
  const out: PendingItem[] = []
  const name = (t: TargetRowLite) => `${t.project} (${t.environment})`
  for (const t of targetRows) {
    const last = lastStatus.find(l => l.targetId === t.id)
    if (t.pendingAction) {
      // Vérifiée, jamais déclarée : levée ici si la condition est remplie.
      const st = await resolvePending(t.id)
      if (st && !st.done) out.push({ kind: 'action', severity: 'warning', title: `${name(t)} : ${t.pendingAction.title}`, detail: st.missing, link: st.link, at: t.pendingAction.at })
    }
    if (!last) out.push({ kind: 'never-deployed', severity: 'info', title: `${name(t)} : jamais déployé`, detail: 'Cible créée, aucun déploiement', link: `/projects/${t.projectId}?deploy=1`, at: null })
    else if (last.status === 'STOPPED') out.push({ kind: 'stopped', severity: 'warning', title: `${name(t)} : arrêté`, detail: 'Redémarrer ou redéployer', link: `/projects/${t.projectId}`, at: last.at.toISOString() })
    else if (FAILED_STATUSES.includes(last.status as DeploymentStatus) && !last.acknowledgedAt) out.push({ kind: 'failed', severity: 'danger', title: `${name(t)} : dernier déploiement en échec`, detail: t.current ? 'La release précédente reste en service' : 'Aucune release en service', link: `/deployments/${last.id}`, at: last.at.toISOString() })
    if (last && t.current && last.status !== 'STOPPED') {
      const changed = variablesNotDeployed(t.variablesMeta, await lastActivationAt({ id: t.id, currentReleaseId: t.current }))
      if (changed.length) out.push({ kind: 'redeploy', severity: 'warning', title: `${name(t)} : ${changed.length} variable${changed.length > 1 ? 's' : ''} à déployer`, detail: `${changed.slice(0, 3).join(', ')}${changed.length > 3 ? '…' : ''} modifiée${changed.length > 1 ? 's' : ''} depuis le déploiement en service : appliquée${changed.length > 1 ? 's' : ''} au prochain déploiement`, link: `/projects/${t.projectId}?tab=variables`, at: null })
    }
    const toApply = last && t.current && last.status !== 'STOPPED' ? watchtowerToApply(t, engineImage) : null
    if (toApply) {
      out.push({ kind: 'redeploy', severity: 'warning', title: `${name(t)} : Watchtower à appliquer`, detail: `${TO_APPLY_DETAIL[toApply]} : mis en service au prochain déploiement`, link: toApply === 'image' ? '/images' : `/projects/${t.projectId}?tab=watchtower`, at: null })
    }
  }

  // Release en service dont les labels Traefik ne correspondent plus à la configuration de l'endpoint
  // (résolveur ACME retiré ou changé) : un redéploiement régénère les labels.
  const currentIds = targetRows.map(t => t.current).filter((x): x is string => !!x)
  if (currentIds.length) {
    const rels = await db().select({ id: schema.releases.id, targetId: schema.releases.targetId, compose: schema.releases.composeFinal, endpointId: schema.projectTargets.endpointId, environmentId: schema.projectTargets.environmentId })
      .from(schema.releases).innerJoin(schema.projectTargets, eq(schema.projectTargets.id, schema.releases.targetId))
      .where(inArray(schema.releases.id, currentIds))
    const tcs = await db().select({ endpointId: schema.traefikConfigs.endpointId, environmentId: schema.traefikConfigs.environmentId, certResolver: schema.traefikConfigs.certResolver }).from(schema.traefikConfigs)
      .where(inArray(schema.traefikConfigs.endpointId, [...new Set(rels.map(r => r.endpointId))]))
    for (const r of rels) {
      const used = [...new Set([...(r.compose ?? '').matchAll(/\.tls\.certresolver[=:]\s*["']?([A-Za-z0-9_-]+)/g)].map(m => m[1]!))]
      if (!used.length) continue
      const tc = tcs.find(x => x.endpointId === r.endpointId && x.environmentId === r.environmentId) ?? tcs.find(x => x.endpointId === r.endpointId && x.environmentId === null)
      const stale = used.filter(u => u !== tc?.certResolver)
      const t = targetRows.find(x => x.id === r.targetId)!
      if (stale.length) out.push({ kind: 'redeploy', severity: 'warning', title: `${name(t)} : redéploiement nécessaire`, detail: `Ses routes utilisent le résolveur « ${stale.join(', ')} », absent de la configuration Traefik actuelle`, link: `/projects/${t.projectId}`, at: null })
    }
  }

  // Archives importées (ZIP, release GitHub, Compose généré) non déployées : rattachées au projet par le journal d'audit.
  const projectIds = [...new Set(targetRows.map(t => t.projectId))]
  const since = new Date(Date.now() - 24 * 3600_000)
  const uploads = await db().select({ id: schema.uploads.id, name: schema.uploads.originalName, at: schema.uploads.createdAt }).from(schema.uploads)
    .where(and(sql`${schema.uploads.consumedAt} is null`, gte(schema.uploads.createdAt, since)))
  if (uploads.length && projectIds.length) {
    const ae = schema.auditEvents
    const links = await db().select({ uploadId: sql<string>`coalesce(${ae.details}->>'uploadId', ${ae.targetId})`, projectId: ae.projectId }).from(ae)
      .where(and(inArray(ae.action, ['upload.create', 'generator.run']), inArray(ae.projectId, projectIds), gte(ae.ts, since)))
    // Une entrée par projet : nombre d'archives, la plus récente nommée, échéance de la plus ancienne.
    const byProject = new Map<string, { names: string[], oldest: Date, newest: Date }>()
    for (const u of uploads.toSorted((a, b) => b.at.getTime() - a.at.getTime())) {
      const projectId = links.find(l => l.uploadId === u.id)?.projectId
      if (!projectId || !targetRows.some(x => x.projectId === projectId)) continue
      const g = byProject.get(projectId) ?? { names: [], oldest: u.at, newest: u.at }
      g.names.push(u.name)
      if (u.at < g.oldest) g.oldest = u.at
      byProject.set(projectId, g)
    }
    for (const [projectId, g] of byProject) {
      const t = targetRows.find(x => x.projectId === projectId)!
      const hours = Math.max(1, Math.round((g.oldest.getTime() + 24 * 3600_000 - Date.now()) / 3600_000))
      const title = g.names.length === 1 ? `${t.project} : ${g.names[0]} importé, non déployé` : `${t.project} : ${g.names.length} archives importées, non déployées`
      out.push({ kind: 'upload', severity: 'info', title, detail: `${g.names.length > 1 ? `Dernière : ${g.names[0]}. ` : ''}Supprimées automatiquement sous ${hours} h si elles ne sont pas déployées`, link: `/projects/${projectId}?deploy=1`, at: g.newest.toISOString() })
    }
  }

  // Infrastructure : ACME refusé, réseaux à revoir (serveurs visibles uniquement).
  if (canOn(user, 'server:read', {}) || servers?.length) {
    const eps = await db().select({ id: schema.serverEndpoints.id, serverId: schema.serverEndpoints.serverId, server: schema.portainerServers.name })
      .from(schema.serverEndpoints).innerJoin(schema.portainerServers, eq(schema.portainerServers.id, schema.serverEndpoints.serverId))
      .where(servers === null ? undefined : inArray(schema.serverEndpoints.serverId, servers.length ? servers : ['00000000-0000-0000-0000-000000000000']))
    if (eps.length) {
      const proxies = await db().select({ endpointId: schema.managedProxies.endpointId, applied: schema.managedProxies.appliedConfig }).from(schema.managedProxies).where(inArray(schema.managedProxies.endpointId, eps.map(e => e.id)))
      for (const m of proxies) {
        const ep = eps.find(e => e.id === m.endpointId)!
        const acme = m.applied?.acme
        if (acme?.enabled && acme.email && !acme.caServer && RESERVED_TLD.test(acme.email)) {
          out.push({ kind: 'acme', severity: 'warning', title: `Traefik géré (${ep.server}) : e-mail ACME refusé par Let's Encrypt`, detail: 'Aucun certificat ne peut être obtenu : renseigner une adresse réelle', link: `/servers/${ep.serverId}?tab=traefik`, at: null })
        }
      }
      // Certificats importés : à mettre en service (appliquer le Traefik géré), bientôt expirés, expirés.
      for (const ep of eps) {
        const certs = await listCertificates(ep.id)
        if (!certs.length) continue
        const link = `/servers/${ep.serverId}?tab=traefik`
        const toApply = certs.filter(c => c.pendingApply && c.state !== 'expired')
        if (toApply.length) out.push({ kind: 'certificate', severity: 'warning', title: `Traefik géré (${ep.server}) : ${toApply.length} certificat(s) importé(s) pas encore en service`, detail: `Appliquer le Traefik géré : ${toApply.flatMap(c => c.domains).slice(0, 3).join(', ')}`, link, at: null })
        for (const c of certs.filter(x => x.state !== 'valid')) {
          out.push({ kind: 'certificate', severity: c.state === 'expired' ? 'danger' : 'warning', title: `Certificat ${c.domains[0]}${c.domains.length > 1 ? ` (+${c.domains.length - 1})` : ''} ${c.state === 'expired' ? 'expiré' : 'expire bientôt'}`, detail: `${c.issuer}, jusqu'au ${new Date(c.notAfter).toLocaleDateString('fr-FR')} : importer le certificat renouvelé`, link, at: c.notAfter })
        }
      }
      const nets = await db().select({ endpointId: schema.networks.endpointId, n: count() }).from(schema.networks)
        .where(and(inArray(schema.networks.endpointId, eps.map(e => e.id)), eq(schema.networks.policy, 'unreviewed'), eq(schema.networks.missing, false)))
        .groupBy(schema.networks.endpointId)
      for (const r of nets) {
        const ep = eps.find(e => e.id === r.endpointId)!
        out.push({ kind: 'networks', severity: 'info', title: `${ep.server} : ${r.n} réseau(x) à revoir`, detail: 'Politique non décidée (autoriser ou interdire)', link: `/servers/${ep.serverId}?tab=networks`, at: null })
      }
    }
  }
  const rank = { danger: 0, warning: 1, info: 2 } as const
  return out.sort((a, b) => rank[a.severity] - rank[b.severity])
}

function or_(...c: (SQL | undefined)[]): SQL {
  return sql`(${sql.join(c.filter(Boolean) as SQL[], sql` or `)})`
}
