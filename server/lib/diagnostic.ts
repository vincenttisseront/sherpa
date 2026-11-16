/**
 * Cause probable d'un service en difficulté, à partir de faits relevés sur le
 * conteneur (fonction pure) : absent, arrêté proprement, tué, OOM, erreur au
 * démarrage, redémarrage en boucle, healthcheck en échec ou trop lent.
 */
import type { DiagnosticAction, DiagnosticFinding, ServiceDiagnostic, TargetDiagnostic } from '../../shared/schemas/diagnostic'
import type { LogInsight } from '../../shared/utils/log-insights'

/** Lignes de log révélatrices d'une erreur (insensible à la casse). */
const NOTABLE = /\b(error|fatal|panic|exception|traceback|refused|denied|forbidden|unauthori[sz]ed|no such|not found|cannot|can't|could not|failed|timeout|timed out|unable|oom|killed|segfault|permission)\b/i

export function notableLines(lines: readonly string[], max = 8): string[] {
  return lines.filter(l => NOTABLE.test(l)).slice(-max)
}

/** Signification d'un code de sortie courant. */
export function exitMeaning(code: number | null, oomKilled: boolean): string | null {
  if (code === null) return null
  if (oomKilled) return 'tué par manque de mémoire (OOM)'
  if (code === 0) return 'arrêt normal'
  if (code === 137) return 'tué (SIGKILL : arrêt forcé, docker stop dépassé ou mémoire)'
  if (code === 143) return 'arrêté (SIGTERM)'
  if (code === 139) return 'plantage (segmentation fault)'
  if (code === 126 || code === 127) return 'commande introuvable ou non exécutable'
  if (code === 1 || code === 2) return 'erreur de l\'application au démarrage'
  return `code ${code}`
}

type Facts = Omit<ServiceDiagnostic, 'findings'>

export interface DiagnoseContext {
  projectId: string
  endpointId: string
  stack: string
  /** Tous les services de la stack sont arrêtés. */
  allStopped: boolean
}

export function diagnoseService(f: Facts, ctx: DiagnoseContext): DiagnosticFinding[] {
  const out: DiagnosticFinding[] = []
  const logs: DiagnosticAction = { kind: 'link', label: 'Voir les logs', to: `/containers?endpoint=${ctx.endpointId}&stack=${encodeURIComponent(ctx.stack)}` }
  const lastError = f.notableLogs.at(-1) ?? null
  if (f.state === 'missing') {
    out.push({ severity: 'error', title: 'Conteneur absent', detail: 'Le service est dans la release active mais aucun conteneur n\'existe : la stack a été supprimée ou modifiée hors plateforme.', actions: [{ kind: 'redeploy' }] })
    return out
  }
  if (f.oomKilled) {
    out.push({ severity: 'error', title: 'Arrêté par manque de mémoire (OOM)', detail: 'Le noyau a tué le conteneur : augmenter la limite mémoire du service, ou la mémoire allouée à Docker sur l\'hôte, puis redémarrer.', actions: [{ kind: 'restart-service', service: f.service }, logs] })
  }
  else if (f.state === 'restarting' || (f.restartCount >= 3 && f.state !== 'running' && !ctx.allStopped)) {
    out.push({ severity: 'error', title: `Redémarre en boucle (${f.restartCount} redémarrage(s))`, detail: lastError ? `Dernière erreur : ${lastError}` : 'Le processus s\'arrête juste après son lancement : lire les logs du service.', actions: [logs, { kind: 'link', label: 'Variables', to: `/projects/${ctx.projectId}?tab=variables` }] })
  }
  else if (f.state === 'exited' || f.state === 'dead' || f.state === 'created') {
    const meaning = exitMeaning(f.exitCode, false)
    // Stack entièrement arrêtée : les codes de sortie sont le plus souvent la conséquence de l'arrêt.
    if (ctx.allStopped || f.exitCode === 0 || f.exitCode === 143) {
      out.push({
        severity: ctx.allStopped ? 'warning' : 'info',
        title: ctx.allStopped ? `Arrêté (${meaning})` : `Terminé (${meaning})`,
        detail: ctx.allStopped
          ? `Toute la stack est arrêtée : arrêt demandé (plateforme, Docker Desktop, docker stop) ou redémarrage de l'hôte.${f.exitCode && f.exitCode !== 143 && f.exitCode !== 137 && f.notableLogs.length ? ` Dernière erreur : ${f.notableLogs.at(-1)}` : ''}`
          : 'Service terminé normalement : tâche ponctuelle (migration, init) ou processus sorti sans erreur.',
        actions: ctx.allStopped ? [] : [{ kind: 'restart-service', service: f.service }],
      })
    }
    else {
      out.push({ severity: 'error', title: `Arrêté en erreur (${meaning})`, detail: lastError ? `Dernière erreur : ${lastError}` : 'Lire les logs du service pour la cause.', actions: [{ kind: 'restart-service', service: f.service }, logs] })
    }
  }
  if (f.state === 'running' && f.health === 'unhealthy') {
    const last = f.healthLog[0]
    const slow = !!last && /timed out|timeout|deadline/i.test(last.output)
    out.push({
      severity: 'error',
      title: slow ? 'Healthcheck trop lent' : 'Healthcheck en échec',
      detail: slow
        ? `La vérification dépasse son délai (${last!.output.trim().slice(0, 160)}). Si le service démarre lentement (migrations), allonger start_period ou l'intervalle dans Réglages → Healthchecks.`
        : last ? `Dernière vérification (code ${last.exitCode}) : ${last.output.trim().slice(0, 200) || 'aucune sortie'}` : 'Le service répond mal à sa vérification de santé.',
      actions: slow
        ? [{ kind: 'link', label: 'Réglages des healthchecks', to: `/projects/${ctx.projectId}?tab=settings` }, { kind: 'restart-service', service: f.service }]
        : [{ kind: 'restart-service', service: f.service }, logs],
    })
  }
  else if (f.state === 'running' && f.health === 'starting') {
    out.push({ severity: 'warning', title: 'Démarrage en cours', detail: 'Le healthcheck n\'a pas encore conclu ; s\'il reste en démarrage, allonger start_period (Réglages → Healthchecks).', actions: [{ kind: 'link', label: 'Réglages des healthchecks', to: `/projects/${ctx.projectId}?tab=settings` }] })
  }
  if (f.state === 'running' && f.restartCount >= 3 && !out.length) {
    out.push({ severity: 'warning', title: `${f.restartCount} redémarrage(s) depuis la création`, detail: lastError ? `Dernière erreur : ${lastError}` : 'Le service s\'est arrêté plusieurs fois : surveiller les logs.', actions: [logs] })
  }
  if (!out.length) out.push({ severity: 'ok', title: f.health === 'healthy' ? 'Sain' : 'En marche', detail: null, actions: [] })
  return out
}

/** Constatations de l'analyse des logs : cause probable et quoi faire, avec la ligne en cause. */
export function logFindings(insights: readonly LogInsight[]): DiagnosticFinding[] {
  return insights.slice(0, 4).map(i => ({
    severity: i.severity,
    title: `Logs : ${i.title}${i.count > 1 ? ` (×${i.count})` : ''}`,
    detail: `${i.explain} À faire : ${i.fix} — Ligne : ${i.sample}`,
    actions: [],
  }))
}

/** Verdict global de la cible, à partir des constats des services. */
export function summarize(services: readonly ServiceDiagnostic[], ctx: DiagnoseContext): TargetDiagnostic['summary'] {
  const bad = services.filter(s => s.findings.some(f => f.severity === 'error'))
  const missing = services.filter(s => s.state === 'missing')
  if (!services.length) return { severity: 'error', title: 'Aucun conteneur pour cette stack', detail: 'La stack n\'existe pas (ou plus) sur l\'hôte.', actions: [{ kind: 'redeploy' }] }
  if (ctx.allStopped) return { severity: 'warning', title: 'Stack arrêtée', detail: 'Tous les services sont arrêtés. Démarrer la stack la relance avec sa configuration actuelle.', actions: [{ kind: 'start' }] }
  if (missing.length) return { severity: 'error', title: `${missing.length} service(s) sans conteneur`, detail: 'Redéployer la release active recrée les conteneurs manquants.', actions: [{ kind: 'redeploy' }] }
  if (bad.length) return { severity: 'error', title: `${bad.length} service(s) en difficulté : ${bad.map(s => s.service).join(', ')}`, detail: 'Voir les constats ci-dessous ; un service qui dépend d\'un autre en échec se rétablit souvent une fois celui-ci réparé.', actions: [{ kind: 'restart' }] }
  if (services.some(s => s.findings.some(f => f.severity === 'warning'))) return { severity: 'warning', title: 'Points à surveiller', detail: null, actions: [] }
  return { severity: 'ok', title: 'Tous les services sont en marche', detail: null, actions: [] }
}
