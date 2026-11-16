import { Queue } from 'bullmq'
import { redis } from './redis'

export const QUEUE_DEPLOYMENTS = 'deployments'
export const QUEUE_MAINTENANCE = 'maintenance'
export const QUEUE_NOTIFICATIONS = 'notifications'
/** Analyses longues (Trivy) : file à part, pour ne pas retarder la maintenance. */
export const QUEUE_SCANS = 'scans'
/** Relevés de ressources des conteneurs (chaque minute) : file à part, un relevé lent ne retarde pas la maintenance. */
export const QUEUE_METRICS = 'metrics'
/** Clé Redis de présence du worker (TTL 60 s, renouvelée toutes les 20 s). */
export const WORKER_HEARTBEAT_KEY = 'worker:heartbeat'

export interface DeploymentJobData {
  deploymentId: string
  projectId: string
  environmentId: string
}

export type MaintenanceJobName = 'retention-purge' | 'server-health' | 'uploads-purge' | 'files-cleanup' | 'watchtower-report' | 'watchtower-profile-report' | 'targets-observe' | 'deployments-recover' | 'proxy-routes-attach'

let deployments: Queue<DeploymentJobData> | undefined
let maintenance: Queue | undefined
let notifications: Queue | undefined
let scans: Queue | undefined
let metrics: Queue | undefined

export function deploymentQueue(): Queue<DeploymentJobData> {
  deployments ??= new Queue<DeploymentJobData>(QUEUE_DEPLOYMENTS, {
    connection: redis(),
    defaultJobOptions: {
      // Pas de retry automatique : un déploiement est rejoué explicitement.
      attempts: 1,
      removeOnComplete: { age: 7 * 24 * 3600 },
      removeOnFail: { age: 30 * 24 * 3600 },
    },
  })
  return deployments
}

export function maintenanceQueue(): Queue {
  maintenance ??= new Queue(QUEUE_MAINTENANCE, { connection: redis() })
  return maintenance
}

/**
 * Met un déploiement en file. Le jobId est la clé d'idempotence : un même
 * ordre soumis deux fois ne crée qu'un job.
 */
export async function enqueueDeployment(data: DeploymentJobData, idempotencyKey: string, delayMs = 0) {
  // BullMQ refuse un identifiant contenant « : », sauf au format a:b:c (celui des clés usuelles).
  const jobId = idempotencyKey.split(':').length === 3 ? idempotencyKey : idempotencyKey.replaceAll(':', '_')
  return deploymentQueue().add('run', data, { jobId, ...(delayMs > 0 ? { delay: delayMs } : {}) })
}

export function scanQueue(): Queue {
  scans ??= new Queue(QUEUE_SCANS, { connection: redis() })
  return scans
}

/** Notifications : une tâche de répartition par évènement, puis une tâche par envoi (avec reprises). */
export function notificationQueue(): Queue {
  notifications ??= new Queue(QUEUE_NOTIFICATIONS, {
    connection: redis(),
    defaultJobOptions: { removeOnComplete: { age: 24 * 3600 }, removeOnFail: { age: 7 * 24 * 3600 } },
  })
  return notifications
}

export function metricsQueue(): Queue {
  metrics ??= new Queue(QUEUE_METRICS, { connection: redis(), defaultJobOptions: { removeOnComplete: { count: 20 }, removeOnFail: { count: 50 } } })
  return metrics
}
