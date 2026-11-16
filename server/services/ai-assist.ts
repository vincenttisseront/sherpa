/**
 * Fonctions d'assistance par Ollama qui lisent des données déjà présentes dans la plateforme :
 * déploiement en échec, synthèse tech support, historique des ressources, reverse proxies. Chacune
 * assemble ses blocs de contexte (masqués par le socle commun avant envoi) puis laisse `runAiReport`
 * faire l'appel. Les droits d'accès sont vérifiés par les routes, comme pour la lecture des mêmes données.
 */
import { and, desc, eq, gte } from 'drizzle-orm'
import { createError } from 'h3'
import type { AiReportDto } from '../../shared/schemas/ollama'
import { METRIC_RANGES, type MetricRange } from '../../shared/schemas/metrics'
import { portainer } from '../adapters/portainer'
import { db, schema } from '../db/client'
import { deploymentParts, metricsParts, proxyParts, supportParts } from '../lib/ollama/contexts'
import { noProgress, type Progress } from '../utils/progress'
import { runAiReport } from './ai-task'
import { diagnoseTarget } from './diagnostic'
import type { EndpointRow } from './live'
import { loadDeploymentDetail } from './deployments'
import { deploymentLogLines } from './log-analysis'
import { metricsFor } from './metrics'
import { getTargetOr404, type TargetRow } from './projects'
import { endpointProxyMap } from './proxy-map'
import { connectionFor } from './servers'
import { techSupportReport } from './tech-support'

/** Lecture facultative : un hôte injoignable ne doit pas empêcher d'analyser ce qu'on a déjà. */
async function within<T>(ms: number, task: Promise<T>): Promise<T | null> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([task, new Promise<null>((resolve) => { timer = setTimeout(() => resolve(null), ms) })])
  }
  catch {
    return null
  }
  finally {
    clearTimeout(timer)
  }
}

/** Déploiement en échec : faits, étapes, état réel de la stack (si l'hôte répond) et journal. */
export async function diagnoseDeploymentFailure(deploymentId: string, opts: { focus?: string, progress?: Progress } = {}): Promise<AiReportDto> {
  const progress = opts.progress ?? noProgress
  await progress.step('Lecture du déploiement et de son journal', 1, 3)
  const detail = await loadDeploymentDetail(deploymentId)
  const [dep] = await db().select({ targetId: schema.deployments.targetId }).from(schema.deployments).where(eq(schema.deployments.id, deploymentId))
  const logs = await deploymentLogLines(deploymentId, { levels: ['info', 'warn', 'error'], limit: 1500 })
  await progress.step('Lecture de l\'état réel de la stack sur l\'hôte', 2, 3)
  const target = dep ? await getTargetOr404(dep.targetId).catch(() => null) : null
  const diagnostic = target ? await within(12_000, diagnoseTarget(target, { logs: true })) : null
  await progress.step('Analyse par le modèle Ollama (peut prendre une minute)', 3, 3)
  return runAiReport({
    feature: 'deploy-failure',
    header: [`Déploiement ${detail.id.slice(0, 8)} du projet ${detail.project.name}, environnement ${detail.environment.name}`],
    parts: deploymentParts(detail, diagnostic, logs),
    focus: opts.focus,
  })
}

/** Synthèse du rapport tech support de la cible (le rapport est déjà masqué), avec un texte de ticket. */
export async function summarizeTechSupport(t: TargetRow, opts: { logs: boolean, by: string, focus?: string, progress?: Progress }): Promise<AiReportDto> {
  const progress = opts.progress ?? noProgress
  await progress.step('Constitution du rapport tech support', 1, 2)
  const report = await techSupportReport(t, { logs: opts.logs, by: opts.by })
  await progress.step('Analyse par le modèle Ollama (peut prendre une minute)', 2, 2)
  return runAiReport({
    feature: 'support',
    header: [`Cible : projet ${t.project.name}, environnement ${t.env.name}, serveur ${t.server.name}`],
    parts: supportParts(report),
    focus: opts.focus,
    withDraft: true,
  })
}

/** Historique des ressources d'un conteneur, avec les déploiements du même projet sur la période. */
export async function analyzeContainerMetrics(row: EndpointRow, containerId: string, range: MetricRange, opts: { focus?: string, progress?: Progress } = {}): Promise<AiReportDto> {
  const progress = opts.progress ?? noProgress
  await progress.step('Lecture de l\'historique du conteneur', 1, 2)
  const container = await portainer().inspectContainer(await connectionFor(row.server), row.ep.portainerEndpointId, containerId)
  if (!container) throw createError({ statusCode: 404, statusMessage: 'Conteneur introuvable' })
  const dto = await metricsFor(row.ep.id, container.name, range)
  if (!dto.points.length) throw createError({ statusCode: 422, statusMessage: 'Aucun relevé pour ce conteneur : seuls ceux déployés par la plateforme sont suivis' })

  const slug = container.labels['platform.project']
  const since = new Date(Date.now() - METRIC_RANGES[range] * 60_000)
  const deployments = slug
    ? await db().select({ at: schema.deployments.createdAt, action: schema.deployments.action, status: schema.deployments.status })
      .from(schema.deployments)
      .innerJoin(schema.projectTargets, eq(schema.projectTargets.id, schema.deployments.targetId))
      .innerJoin(schema.projects, eq(schema.projects.id, schema.projectTargets.projectId))
      .where(and(eq(schema.projects.slug, slug), eq(schema.projectTargets.endpointId, row.ep.id), gte(schema.deployments.createdAt, since)))
      .orderBy(desc(schema.deployments.createdAt)).limit(15)
    : []
  await progress.step('Analyse par le modèle Ollama (peut prendre une minute)', 2, 2)
  return runAiReport({
    feature: 'metrics',
    header: [`Conteneur ${container.name} (image ${container.image}) sur l'hôte ${row.server.name}${slug ? `, projet ${slug}` : ''}`],
    parts: metricsParts({ dto, deployments: deployments.map(d => ({ at: d.at.toISOString(), action: d.action, status: d.status })) }),
    focus: opts.focus,
  })
}

/** Carte des reverse proxies de l'hôte (extraction par liste blanche : ni valeurs de configuration, ni identifiants). */
export async function explainProxies(row: EndpointRow, opts: { focus?: string, progress?: Progress } = {}): Promise<AiReportDto> {
  const progress = opts.progress ?? noProgress
  await progress.step('Lecture des reverse proxies de l\'hôte', 1, 2)
  const map = await endpointProxyMap(row, { progress: noProgress })
  await progress.step('Analyse par le modèle Ollama (peut prendre une minute)', 2, 2)
  return runAiReport({
    feature: 'proxy',
    header: [`Hôte : ${row.server.name} (endpoint ${row.ep.name})`],
    parts: proxyParts(map),
    focus: opts.focus,
  })
}
