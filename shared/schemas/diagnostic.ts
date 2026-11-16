/**
 * Diagnostic d'une cible dégradée ou arrêtée : état réel de chaque service de la
 * stack, cause probable déduite des faits (code de sortie, OOM, redémarrages,
 * healthcheck, logs) et actions proposées.
 */

export type DiagnosticSeverity = 'ok' | 'info' | 'warning' | 'error'

/** Action proposée pour lever un constat. */
export type DiagnosticAction =
  | { kind: 'start' | 'restart' | 'redeploy' }
  | { kind: 'restart-service', service: string }
  | { kind: 'link', label: string, to: string }

export interface DiagnosticFinding {
  severity: DiagnosticSeverity
  /** Cause probable, en une phrase. */
  title: string
  /** Explication et ce qu'il faut vérifier. */
  detail: string | null
  actions: DiagnosticAction[]
}

export interface ServiceDiagnostic {
  service: string
  container: string | null
  containerId: string | null
  image: string | null
  state: 'running' | 'restarting' | 'exited' | 'created' | 'paused' | 'dead' | 'missing'
  health: 'healthy' | 'unhealthy' | 'starting' | null
  exitCode: number | null
  oomKilled: boolean
  restartCount: number
  startedAt: string | null
  finishedAt: string | null
  /** Dernières vérifications de santé (plus récente en premier). */
  healthLog: { at: string, exitCode: number, output: string }[]
  /** Lignes de log notables (erreurs), secrets masqués ; vide sans le droit logs:read. */
  notableLogs: string[]
  /** Dernières lignes de log (secrets masqués). */
  tail: string[]
  findings: DiagnosticFinding[]
}

export interface TargetDiagnostic {
  targetId: string
  projectId: string
  project: string
  environment: string
  stack: string
  endpointId: string
  serverId: string
  server: string
  checkedAt: string
  /** Synthèse : verdict global et actions de la stack. */
  summary: DiagnosticFinding
  services: ServiceDiagnostic[]
  /** Tous les services sont arrêtés (affichage condensé). */
  allStopped: boolean
  /** Faute de droit logs:read, les logs ne sont pas lus. */
  logsHidden: boolean
}

/** Conteneur d'un service de la cible (onglet Conteneurs du projet). */
export interface TargetContainer {
  service: string
  /** null : service de la release active sans conteneur. */
  id: string | null
  name: string | null
  state: import('./live').LiveState | 'missing'
  health: import('./live').LiveHealth
  /** Libellé Docker (« Up 3 hours (healthy) », « Exited (0) 2 hours ago »). */
  status: string
  image: string | null
  ports: string[]
  /** Fraîcheur de l'image face au registre (vérification de la plateforme). */
  freshness: { state: import('./dashboard').FreshnessState, detail: string } | null
}

export interface TargetContainers {
  targetId: string
  endpointId: string
  stack: string
  checkedAt: string
  containers: TargetContainer[]
  /** Services dont une version plus récente est publiée. */
  outdated: string[]
  freshnessCheckedAt: string | null
  /** Services suspendus : retirés de la stack jusqu'à leur reprise. */
  suspended: { service: string, at: string, by: string | null }[]
}

export const SERVICE_ACTIONS = ['start', 'stop', 'restart'] as const
export type ServiceAction = (typeof SERVICE_ACTIONS)[number]
