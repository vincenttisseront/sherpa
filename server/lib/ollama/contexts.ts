/**
 * Constructeurs de contexte des fonctions d'assistance : des DTO déjà produits par la plateforme
 * (masqués ou limités à une liste blanche) vers des blocs de lignes pour le modèle. Fonctions pures
 * (aucune E/S), testées.
 */
import type { DeploymentDetailDto } from '../../../shared/schemas/deployments'
import type { AnalysisExplainInput } from '../../../shared/schemas/ollama'
import type { TargetDiagnostic } from '../../../shared/schemas/diagnostic'
import type { ActiveAlertDto, MetricPoint, MetricsDto } from '../../../shared/schemas/metrics'
import type { ProxyMapDto } from '../../../shared/schemas/proxy-map'
import { splitReportSections, type ContextPart } from './context'

const stamp = (iso: string): string => `${iso.slice(0, 16)}Z`
const dash = (v: unknown): string => (v === null || v === undefined || v === '' ? '—' : String(v))
const round = (n: number, d = 1): number => Math.round(n * 10 ** d) / 10 ** d

// --- Déploiement en échec ---------------------------------------------------------------------

export function deploymentParts(d: DeploymentDetailDto, diagnostic: TargetDiagnostic | null, logs: readonly string[]): ContextPart[] {
  const durations = Object.entries(d.statusDurations).map(([s, sec]) => `${s} ${sec} s`).join(', ')
  const facts = [
    `Projet : ${d.project.name} · Environnement : ${d.environment.name}${d.environment.isProduction ? ' (production)' : ''} · Serveur : ${d.server.name}`,
    `Action : ${d.action} · Statut : ${d.status} · Échec depuis le statut : ${dash(d.failedFrom)}`,
    `Erreur enregistrée : ${dash(d.error)}`,
    `Début : ${dash(d.startedAt)} · Fin : ${dash(d.finishedAt)}`,
    `Temps passé par statut : ${dash(durations)}`,
    `Release : ${d.release ? `n°${d.release.number}, source ${d.release.sourceKind}` : '—'}`,
    `Options : ${Object.entries(d.options).filter(([, v]) => v).map(([k]) => k).join(', ') || 'aucune'}`,
  ]
  const steps = Object.entries(d.statusDetails).map(([status, m]) => `[${status}] ${m.level} : ${m.message}`)
  return [
    { title: 'Déploiement', lines: facts, weight: 2 },
    { title: 'Dernier message de chaque étape', lines: steps, weight: 1 },
    ...(diagnostic ? [{ title: 'État réel de la stack sur l\'hôte', lines: diagnosticLines(diagnostic), weight: 2 }] : []),
    { title: 'Journal du déploiement', lines: logs, weight: 4 },
  ]
}

/** Constats par service du diagnostic de cible (mêmes faits que l'écran de diagnostic). */
export function diagnosticLines(d: TargetDiagnostic): string[] {
  const out = [`Synthèse : [${d.summary.severity}] ${d.summary.title}${d.summary.detail ? ` — ${d.summary.detail}` : ''}`]
  for (const s of d.services) {
    out.push(`Service ${s.service} : état ${s.state}, santé ${dash(s.health)}, code de sortie ${dash(s.exitCode)}${s.oomKilled ? ', tué par manque de mémoire (OOM)' : ''}, ${s.restartCount} redémarrage(s), image ${dash(s.image)}`)
    for (const f of s.findings) out.push(`  - [${f.severity}] ${f.title}${f.detail ? ` — ${f.detail}` : ''}`)
    for (const h of s.healthLog.slice(0, 2)) out.push(`  - healthcheck (code ${h.exitCode}) : ${h.output}`)
    for (const l of s.notableLogs.slice(0, 8)) out.push(`  | ${l}`)
  }
  return out
}

// --- Tech support -----------------------------------------------------------------------------

/** Poids d'une section du rapport tech support : l'état et les journaux d'abord, la configuration en dernier. */
export function supportWeight(title: string): number {
  if (/^(Diagnostic|Cible)$/.test(title)) return 3
  if (/^Journal/.test(title)) return 3
  if (/^(Conteneurs|Déploiements|Santé|Release)/.test(title)) return 2
  if (/Compose final|Configuration : variables/.test(title)) return 0.4
  return 1
}

export function supportParts(report: string): ContextPart[] {
  return splitReportSections(report).map(s => ({ title: s.title, lines: s.lines, weight: supportWeight(s.title) }))
}

// --- Historique des ressources ----------------------------------------------------------------

export interface SeriesStats { min: number, avg: number, max: number, first: number, last: number, trend: 'en hausse' | 'en baisse' | 'stable' }

/** Min, moyenne, max, début, fin et tendance (premier tiers contre dernier tiers) d'une série. */
export function seriesStats(values: readonly number[]): SeriesStats | null {
  if (!values.length) return null
  const avg = (v: readonly number[]) => v.reduce((n, x) => n + x, 0) / v.length
  const third = Math.max(1, Math.floor(values.length / 3))
  const head = avg(values.slice(0, third))
  const tail = avg(values.slice(-third))
  const delta = tail - head
  const trend = Math.abs(delta) < Math.max(5, Math.abs(head) * 0.15) ? 'stable' : delta > 0 ? 'en hausse' : 'en baisse'
  return { min: round(Math.min(...values)), avg: round(avg(values)), max: round(Math.max(...values)), first: round(values[0]!), last: round(values.at(-1)!), trend }
}

const memPercent = (p: MetricPoint): number | null => (p.memory !== null && p.memoryLimit ? (p.memory / p.memoryLimit) * 100 : null)
const mib = (bytes: number): number => round(bytes / 1_048_576, 0)

export interface MetricsContext {
  dto: MetricsDto
  deployments: { at: string, action: string, status: string }[]
}

export function metricsParts({ dto, deployments }: MetricsContext): ContextPart[] {
  const cpu = seriesStats(dto.points.map(p => p.cpu).filter((v): v is number => v !== null))
  const memPct = seriesStats(dto.points.map(memPercent).filter((v): v is number => v !== null))
  const memBytes = seriesStats(dto.points.map(p => p.memory).filter((v): v is number => v !== null).map(b => b / 1_048_576))
  const limit = dto.points.findLast(p => p.memoryLimit)?.memoryLimit ?? null
  const restarts = dto.points.map(p => p.restarts).filter((v): v is number => v !== null)
  const gained = restarts.length > 1 ? restarts.reduce((n, v, i) => n + (i ? Math.max(0, v - restarts[i - 1]!) : 0), 0) : 0
  const first = dto.points[0]
  const last = dto.points.at(-1)

  const summary = [
    `Conteneur : ${dto.container} · Période : ${dto.range} · ${dto.points.length} relevés${first && last ? ` (de ${stamp(first.t)} à ${stamp(last.t)})` : ''}`,
    cpu ? `CPU (100 % = un cœur) : min ${cpu.min}, moyenne ${cpu.avg}, max ${cpu.max}, début ${cpu.first}, fin ${cpu.last}, tendance ${cpu.trend}` : 'CPU : aucun relevé',
    memPct ? `Mémoire (% de la limite${limit ? ` de ${mib(limit)} Mio` : ''}) : min ${memPct.min}, moyenne ${memPct.avg}, max ${memPct.max}, début ${memPct.first}, fin ${memPct.last}, tendance ${memPct.trend}`
      : memBytes ? `Mémoire (Mio, sans limite de conteneur) : min ${memBytes.min}, moyenne ${memBytes.avg}, max ${memBytes.max}, début ${memBytes.first}, fin ${memBytes.last}, tendance ${memBytes.trend}` : 'Mémoire : aucun relevé',
    `Redémarrages sur la période : ${gained}${restarts.length ? ` (compteur de ${restarts[0]} à ${restarts.at(-1)})` : ''}`,
  ]
  // Une ligne par relevé, au plus ~60 : régulièrement espacés.
  const step = Math.max(1, Math.ceil(dto.points.length / 60))
  const series = dto.points.filter((_, i) => i % step === 0 || i === dto.points.length - 1)
    .map(p => `${stamp(p.t)} cpu ${dash(p.cpu)} % · mémoire ${p.memory === null ? '—' : `${mib(p.memory)} Mio`}${memPercent(p) === null ? '' : ` (${round(memPercent(p)!)} %)`} · redémarrages ${dash(p.restarts)}`)
  const alerts = dto.alerts.map((a: ActiveAlertDto) => `${a.rule} (${a.metric}) : valeur ${dash(a.value)} pour un seuil de ${a.threshold}, depuis ${stamp(a.since)}`)
  const deps = deployments.map(d => `${stamp(d.at)} ${d.action} → ${d.status}`)
  return [
    { title: 'Synthèse chiffrée', lines: summary, weight: 2 },
    { title: 'Relevés (heure UTC)', lines: series, weight: 3 },
    { title: 'Alertes en cours', lines: alerts, weight: 1 },
    { title: 'Déploiements de la période (heure UTC)', lines: deps, weight: 1 },
  ]
}

// --- Reverse proxies --------------------------------------------------------------------------

export function proxyParts(map: ProxyMapDto): ContextPart[] {
  const t = map.topology
  const proxies = t.proxies.flatMap((p) => {
    const ports = p.hostPorts.map(h => `${h.host}→${h.container}/${h.protocol}`).join(', ')
    return [
      `${p.kind} « ${p.container.name} » (image ${p.container.image}, ${p.container.running ? 'en marche' : 'arrêté'}) · version ${dash(p.version)} · réseaux ${p.networks.join(', ') || '—'} · ports publiés ${ports || '—'}`,
      ...(p.traefik ? [`  points d'entrée : ${p.traefik.entrypoints.map(e => `${e.name}${e.address ? ` ${e.address}` : ''}`).join(', ') || '—'} · résolveurs ACME : ${p.traefik.certResolvers.map(r => r.name).join(', ') || '—'}`] : []),
      ...p.warnings.map(w => `  ! ${w}`),
    ]
  })
  const routes = t.routes.map(r => [
    `${r.router} (${r.kind}, ${r.provider})`,
    `hôtes ${r.hosts.join(', ') || '—'}${r.pathPrefix ? ` chemin ${r.pathPrefix}` : ''}`,
    `points d'entrée ${r.entrypoints.join(', ') || '—'}`,
    `TLS ${r.tls ? `oui${r.certResolver ? ` (résolveur ${r.certResolver})` : ''}` : 'non'}${r.redirectsToHttps ? ', redirigé vers HTTPS' : ''}`,
    `middlewares ${r.middlewares.join(', ') || '—'}`,
    `→ ${r.container ? `${r.container.name}${r.targetPort ? `:${r.targetPort}` : ''}` : dash(r.targetUrl)}${r.network ? ` via ${r.network}` : ''}`,
    ...(r.reattach ? [`conteneur absent du réseau de Traefik (${r.reattach.reason})`] : []),
    ...r.warnings.map(w => `! ${w}`),
  ].join(' | '))
  const certs = map.certificates.map(c => `${c.host} : ${c.state}${c.issuer ? `, émetteur ${c.issuer}` : ''}${c.notAfter ? `, expire ${c.notAfter.slice(0, 10)}` : ''}${c.staging ? ' (environnement de test ACME)' : ''}${c.error ? `, erreur : ${c.error}` : ''}`)
  const resolvers = map.resolvers.map(r => `${r.name} : défi ${dash(r.challenge)}${r.dnsProvider ? ` (${r.dnsProvider})` : ''}, ${r.certificates} certificat(s)${r.error ? `, erreur : ${r.error}` : ''}`)
  const acme = map.acmeErrors.map(e => `${dash(e.at)} ${e.domains.join(', ')} : ${e.message}`)
  const direct = map.containers.filter(c => c.hostPorts.length && !t.proxies.some(p => p.container.id === c.id))
    .map(c => `${c.name}${c.project ? ` (projet ${c.project.name})` : ''} : ${c.hostPorts.map(h => `${h.host}→${h.container}/${h.protocol}`).join(', ')}`)
  return [
    { title: 'Reverse proxies détectés', lines: proxies, weight: 2 },
    { title: 'Routes', lines: routes, weight: 4 },
    { title: 'Certificats par domaine', lines: certs, weight: 2 },
    { title: 'Résolveurs ACME', lines: resolvers, weight: 1 },
    { title: 'Erreurs ACME récentes', lines: acme, weight: 2 },
    { title: 'Ports publiés hors proxy', lines: direct, weight: 1 },
    { title: 'Avertissements de la topologie', lines: t.warnings, weight: 1 },
  ]
}

// --- Blocages de l'analyse Compose ------------------------------------------------------------

const SEVERITY_ORDER = { error: 0, warning: 1, info: 2 } as const

/**
 * Constats de l'analyse (codes, messages, ports, volumes, réseaux, domaines). Jamais le Compose ni
 * les valeurs de variables : la liste blanche est appliquée à l'entrée de la route (Zod).
 */
export function analysisParts(a: AnalysisExplainInput): ContextPart[] {
  const issue = (i: AnalysisExplainInput['issues'][number]) => `[${i.severity}] ${i.code}${i.service ? ` (service ${i.service})` : ''} : ${i.message}${i.image ? ` — image ${i.image}` : ''}`
  const sorted = [...a.issues].sort((x, y) => SEVERITY_ORDER[x.severity] - SEVERITY_ORDER[y.severity])
  const refusedPorts = a.ports.filter(p => !p.accepted || p.policy === 'approval' || p.policy === 'forbidden')
  const refusedMounts = a.mounts.filter(m => !m.accepted)
  const refusedNets = a.networks.filter(n => n.status === 'refused')
  const refusedExpo = a.exposures.filter(e => !e.accepted)
  return [
    { title: 'Verdict', lines: [`Compose ${a.ok ? 'conforme' : 'non conforme'} : ${a.issues.filter(i => i.severity === 'error').length} erreur(s), ${a.issues.filter(i => i.severity === 'warning').length} avertissement(s)`], weight: 1 },
    { title: 'Constats de l\'analyse', lines: sorted.map(issue), weight: 4 },
    { title: 'Ports refusés ou à valider', lines: refusedPorts.map(p => `service ${p.service} : ${p.entry} (${p.published ?? 'port non publié'}/${p.protocol}) → ${p.policy}${p.accepted ? '' : ', refusé'} : ${p.reason}`), weight: 2 },
    { title: 'Volumes refusés', lines: refusedMounts.map(m => `service ${m.service} : ${m.type} ${m.source ?? '(anonyme)'} → ${m.target}${m.readOnly ? ' (lecture seule)' : ''} : ${m.reason}`), weight: 2 },
    { title: 'Réseaux refusés', lines: refusedNets.map(n => `${n.name}${n.external ? ' (externe)' : ''} : ${n.reason}`), weight: 1 },
    { title: 'Expositions refusées', lines: refusedExpo.map(e => `service ${e.service} : ${e.host}:${e.port} (${e.router}) : ${e.reason}`), weight: 2 },
  ]
}
