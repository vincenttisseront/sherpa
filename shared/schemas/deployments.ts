import type { GateStateDto } from './deploy-gate'

/** Actions relançables avec les mêmes paramètres (même release). */
export const RELAUNCHABLE: readonly string[] = ['deploy', 'redeploy']

export interface DeploymentDetailDto {
  /** Validation par une autre personne et exécution planifiée. */
  gate: GateStateDto
  id: string
  status: string
  action: string
  error: string | null
  /** Statut au moment de l'échec (FAILED). */
  failedFrom: string | null
  /** Échec acquitté : retiré du tableau de bord. */
  acknowledged: { at: string, by: string | null } | null
  /** Dernier message (hors debug) émis pendant chaque statut traversé. */
  statusDetails: Record<string, { message: string, level: string }>
  /** Temps passé dans chaque statut (secondes), d'après les transitions du journal. */
  statusDurations: Record<string, number>
  createdAt: string
  startedAt: string | null
  finishedAt: string | null
  project: { id: string, slug: string, name: string }
  environment: { key: string, name: string, isProduction: boolean }
  server: { id: string, name: string }
  endpoint: { id: string, name: string }
  release: { id: string, number: number, slug: string | null, sourceKind: string, archiveSha256: string | null, sourceTreeSha256: string | null, remotePath: string | null, builds: number, commitSha: string | null, sourceRef: string | null, current: boolean } | null
  /** Options d'exécution (relance, build propre…). */
  options: { skipBuild: boolean, cleanBuild: boolean, noPull: boolean, upgrade: boolean }
}
