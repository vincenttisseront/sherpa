/** Statuts d'un déploiement (§13) et transitions autorisées. */
export const DEPLOYMENT_STATUSES = [
  'DRAFT',
  'VALIDATING',
  'VALIDATION_FAILED',
  'QUEUED',
  'PREPARING_FILES',
  'BUILDING',
  'DEPLOYING',
  'HEALTH_CHECKING',
  'HEALTHY',
  'DEGRADED',
  'FAILED',
  'ROLLING_BACK',
  'ROLLED_BACK',
  'STOPPED',
  'DELETING',
  'DELETED',
  'CANCELLED',
] as const

export type DeploymentStatus = (typeof DEPLOYMENT_STATUSES)[number]

const TRANSITIONS: Record<DeploymentStatus, readonly DeploymentStatus[]> = {
  DRAFT: ['VALIDATING', 'CANCELLED'],
  VALIDATING: ['VALIDATION_FAILED', 'QUEUED'],
  VALIDATION_FAILED: ['VALIDATING', 'CANCELLED'],
  // Annulable uniquement avant exécution. Les actions de cycle de vie
  // (arrêt, démarrage, redémarrage, suppression) passent directement à DEPLOYING / DELETING.
  QUEUED: ['PREPARING_FILES', 'DEPLOYING', 'DELETING', 'CANCELLED', 'FAILED'],
  PREPARING_FILES: ['BUILDING', 'DEPLOYING', 'FAILED'],
  BUILDING: ['DEPLOYING', 'FAILED'],
  DEPLOYING: ['HEALTH_CHECKING', 'STOPPED', 'FAILED', 'ROLLING_BACK'],
  HEALTH_CHECKING: ['HEALTHY', 'DEGRADED', 'FAILED'],
  HEALTHY: ['DEGRADED', 'STOPPED', 'DELETING', 'ROLLING_BACK'],
  DEGRADED: ['HEALTHY', 'ROLLING_BACK', 'STOPPED', 'DELETING'],
  FAILED: ['ROLLING_BACK', 'QUEUED', 'DELETING'],
  ROLLING_BACK: ['ROLLED_BACK', 'FAILED'],
  ROLLED_BACK: ['DELETING'],
  STOPPED: ['QUEUED', 'DELETING'],
  DELETING: ['DELETED', 'FAILED'],
  DELETED: [],
  CANCELLED: [],
}

export const TERMINAL_STATUSES: readonly DeploymentStatus[] = ['VALIDATION_FAILED', 'HEALTHY', 'DEGRADED', 'FAILED', 'ROLLED_BACK', 'STOPPED', 'DELETED', 'CANCELLED']

/** Échecs qu'un utilisateur peut acquitter (retirés du tableau de bord). */
export const FAILED_STATUSES: readonly DeploymentStatus[] = ['FAILED', 'ROLLED_BACK', 'VALIDATION_FAILED']

export const ACTIVE_STATUSES: readonly DeploymentStatus[] = ['VALIDATING', 'QUEUED', 'PREPARING_FILES', 'BUILDING', 'DEPLOYING', 'HEALTH_CHECKING', 'ROLLING_BACK', 'DELETING']

export function canTransition(from: DeploymentStatus, to: DeploymentStatus): boolean {
  return TRANSITIONS[from].includes(to)
}

export function assertTransition(from: DeploymentStatus, to: DeploymentStatus): void {
  if (!canTransition(from, to)) {
    throw new Error(`Transition de statut interdite : ${from} → ${to}`)
  }
}
