/**
 * Diagnostic d'une cible : conteneurs réels de sa stack comparés aux services de la
 * release active, inspection des services en difficulté (code de sortie, OOM,
 * healthcheck) et lignes de log notables (secrets masqués), puis cause probable.
 */
import { eq } from 'drizzle-orm'
import { createError } from 'h3'
import type { ServiceAction, ServiceDiagnostic, TargetContainer, TargetContainers, TargetDiagnostic } from '../../shared/schemas/diagnostic'
import { portainer } from '../adapters/portainer'
import { db, schema } from '../db/client'
import { diagnoseService, logFindings, notableLines, summarize } from '../lib/diagnostic'
import { analyzeLogs } from '../../shared/utils/log-insights'
import { redactPatterns } from '../utils/redact'
import { type TargetRow, stackNameFor } from './projects'
import { freshnessOf } from './image-freshness'
import { connectionFor } from './servers'
import { byCode } from '../../shared/utils/compare'

const TAIL = 120

async function serverRow(t: TargetRow) {
  const [s] = await db().select().from(schema.portainerServers).where(eq(schema.portainerServers.id, t.server.id))
  if (!s) throw createError({ statusCode: 404, statusMessage: 'Serveur introuvable' })
  return s
}

export const stackOfTarget = (t: TargetRow) => t.target.stackName ?? stackNameFor(t.project.slug, t.env.key)

export async function diagnoseTarget(t: TargetRow, opts: { logs: boolean }): Promise<TargetDiagnostic> {
  const stack = stackOfTarget(t)
  const conn = await connectionFor(await serverRow(t))
  const p = portainer()
  const epId = t.endpoint.portainerEndpointId
  const containers = await p.stackContainers(conn, epId, stack)

  // Services attendus : ceux de la release active (images), plus ceux réellement présents.
  const [rel] = t.target.currentReleaseId
    ? await db().select({ images: schema.releases.images }).from(schema.releases).where(eq(schema.releases.id, t.target.currentReleaseId))
    : []
  // Services suspendus ou non gérés : ni attendus, ni signalés absents.
  const aside = new Set([...Object.keys(t.target.composeOverrides?.suspendedServices ?? {}), ...Object.keys(t.target.composeOverrides?.excludedServices ?? {})])
  const expected = Object.keys(rel?.images ?? {}).filter(s => !aside.has(s))
  const names = [...new Set([...expected, ...containers.map(c => c.service ?? c.name)])].sort(byCode)
  const allStopped = containers.length > 0 && containers.every(c => !c.running)
  const ctx = { projectId: t.project.id, endpointId: t.endpoint.id, stack, allStopped }

  const services: ServiceDiagnostic[] = await Promise.all(names.map(async (service) => {
    // Plusieurs conteneurs pour un service (réplicas) : le plus mal en point fait foi.
    const mine = containers.filter(c => (c.service ?? c.name) === service)
    const c = mine.find(x => !x.running) ?? mine.find(x => x.health === 'unhealthy') ?? mine[0]
    if (!c) {
      const facts = { service, container: null, containerId: null, image: rel?.images[service] ?? null, state: 'missing' as const, health: null, exitCode: null, oomKilled: false, restartCount: 0, startedAt: null, finishedAt: null, healthLog: [], notableLogs: [], tail: [] }
      return { ...facts, findings: diagnoseService(facts, ctx) }
    }
    const troubled = !c.running || c.health !== null && c.health !== 'healthy' || c.restartCount >= 3
    const detail = troubled ? await p.inspectContainer(conn, epId, c.id).catch(() => null) : null
    const lines = troubled && opts.logs ? (await p.containerLogs(conn, epId, c.id, TAIL).catch(() => [] as string[])).map(l => redactPatterns(l)) : []
    const state = (['running', 'restarting', 'exited', 'created', 'paused', 'dead'].includes(c.status) ? c.status : c.running ? 'running' : 'exited') as ServiceDiagnostic['state']
    const facts = {
      service,
      container: c.name,
      containerId: c.id,
      image: c.image,
      state,
      health: c.health,
      exitCode: c.running ? null : c.exitCode,
      oomKilled: detail?.state.oomKilled ?? false,
      restartCount: c.restartCount,
      startedAt: c.startedAt,
      finishedAt: detail?.state.finishedAt ?? null,
      healthLog: [...(detail?.health?.log ?? [])].reverse().slice(0, 3).map(h => ({ at: h.start, exitCode: h.exitCode, output: redactPatterns(h.output) })),
      notableLogs: notableLines(lines),
      tail: lines.slice(-15),
    }
    // Causes connues reconnues dans les logs (fichier corrompu, droits, identifiants…).
    return { ...facts, findings: [...diagnoseService(facts, ctx), ...logFindings(analyzeLogs(lines))] }
  }))

  // Les services en difficulté d'abord.
  const rank = (s: ServiceDiagnostic) => Math.min(...s.findings.map(f => ({ error: 0, warning: 1, info: 2, ok: 3 })[f.severity]))
  services.sort((a, b) => rank(a) - rank(b) || a.service.localeCompare(b.service))

  return {
    targetId: t.target.id,
    projectId: t.project.id,
    project: t.project.name,
    environment: t.env.name,
    stack,
    endpointId: t.endpoint.id,
    serverId: t.server.id,
    server: `${t.server.name} / ${t.endpoint.name}`,
    checkedAt: new Date().toISOString(),
    summary: summarize(services, ctx),
    services,
    allStopped,
    logsHidden: !opts.logs,
  }
}

/** Conteneurs de la stack de la cible, avec la fraîcheur de leur image (onglet Conteneurs du projet). */
export async function targetContainers(t: TargetRow): Promise<TargetContainers> {
  const stack = stackOfTarget(t)
  const conn = await connectionFor(await serverRow(t))
  const list = (await portainer().listContainers(conn, t.endpoint.portainerEndpointId)).filter(c => c.labels['com.docker.compose.project'] === stack)
  const [rel] = t.target.currentReleaseId
    ? await db().select({ images: schema.releases.images }).from(schema.releases).where(eq(schema.releases.id, t.target.currentReleaseId))
    : []
  const [fresh] = t.target.currentReleaseId ? await freshnessOf([t.target.id]).catch(() => []) : []
  const freshOf = (service: string) => fresh?.services.find(s => s.service === service) ?? null
  const containers: TargetContainer[] = list.map((c) => {
    const service = c.labels['com.docker.compose.service'] ?? c.names[0]?.replace(/^\//, '') ?? c.id.slice(0, 12)
    const health = /\(healthy\)/.test(c.status) ? 'healthy' : /\(unhealthy\)/.test(c.status) ? 'unhealthy' : /health: starting/.test(c.status) ? 'starting' : null
    const f = freshOf(service)
    return {
      service,
      id: c.id,
      name: c.names[0]?.replace(/^\//, '') ?? null,
      state: c.state as TargetContainer['state'],
      health,
      status: c.status,
      image: c.image,
      ports: (c.ports ?? []).filter(p => p.publicPort).map(p => `${p.ip && p.ip !== '0.0.0.0' ? `${p.ip}:` : ''}${p.publicPort}→${p.privatePort}`),
      freshness: f ? { state: f.state, detail: f.detail } : null,
    }
  })
  const suspended = Object.keys(t.target.composeOverrides?.suspendedServices ?? {})
  const unmanaged = new Set(Object.keys(t.target.composeOverrides?.excludedServices ?? {}))
  for (const service of Object.keys(rel?.images ?? {})) {
    if (!suspended.includes(service) && !unmanaged.has(service) && !containers.some(c => c.service === service)) containers.push({ service, id: null, name: null, state: 'missing', health: null, status: 'aucun conteneur', image: rel!.images[service]!, ports: [], freshness: null })
  }
  containers.sort((a, b) => a.service.localeCompare(b.service))
  return {
    targetId: t.target.id,
    endpointId: t.endpoint.id,
    stack,
    checkedAt: new Date().toISOString(),
    containers,
    outdated: fresh?.services.filter(s => s.state === 'outdated').map(s => s.service) ?? [],
    freshnessCheckedAt: fresh?.checkedAt ?? null,
    suspended: Object.entries(t.target.composeOverrides?.suspendedServices ?? {}).map(([service, v]) => ({ service, at: v.at, by: v.by })),
  }
}

/** Démarre, arrête ou redémarre le conteneur d'un service de la stack (sans redéployer). */
export async function serviceAction(t: TargetRow, service: string, action: ServiceAction): Promise<string> {
  const conn = await connectionFor(await serverRow(t))
  const epId = t.endpoint.portainerEndpointId
  const c = (await portainer().stackContainers(conn, epId, stackOfTarget(t))).find(x => (x.service ?? x.name) === service)
  if (!c) throw createError({ statusCode: 404, statusMessage: `Aucun conteneur pour le service ${service} : redéployer pour le recréer` })
  const p = portainer()
  if (action === 'start') await p.startContainer(conn, epId, c.id)
  else if (action === 'stop') await p.stopContainer(conn, epId, c.id)
  else await p.restartContainer(conn, epId, c.id)
  return c.name
}
