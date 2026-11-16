/**
 * Worker asynchrone : exécute les déploiements et la maintenance.
 * Processus séparé de Nuxt (scalable indépendamment).
 */
import { bakeAllImageOverrides } from '../services/image-upgrade'
import { sampleAll } from '../services/metrics'
import { renewAllNginxCertificates } from '../services/nginx-certificates'
import { runAutoRebuilds } from '../services/rebuild'
import { scanAllGithubConnectors } from '../services/github-connectors'
import { syncRemediationRequests } from '../services/remediation'
import { writeFile } from 'node:fs/promises'
import { DelayedError, Worker } from 'bullmq'
import { closeDb } from '../db/client'
import { acquireLock, deploymentLockKey } from '../queue/lock'
import { QUEUE_DEPLOYMENTS, QUEUE_MAINTENANCE, QUEUE_NOTIFICATIONS, QUEUE_METRICS, QUEUE_SCANS, maintenanceQueue, metricsQueue, type DeploymentJobData } from '../queue/queues'
import { applyTrivySchedule, failTrivyRun, runTrivyScan } from '../services/trivy'
import { deliver, dispatchEvent, runDigests } from '../services/notifications'
import { closeRedis, redis } from '../queue/redis'
import { env } from '../utils/env'
import { createContext, runPipeline } from './pipeline'
import { notifyDeploymentOutcome } from '../services/deployment-notify'
import { processWebhookDelivery, reportGithubDeployment } from '../services/webhooks'
import { failDeployment, recoverOrphanDeployments } from './recovery'
import { WORKER_HEARTBEAT_KEY } from '../queue/queues'
import { purgeExpired } from './retention'
import { checkAllServers, reattachProxyRoutes } from './server-health'
import { cleanupTargetTmp } from './files-cleanup'
import { purgeStaleUploads } from '../services/uploads'
import { handleReport, observeAllTargets } from '../services/watchtower'
import { handleProfileReport } from '../services/watchtower-profiles'

const LOCK_TTL_MS = 60_000
const JOB_TIMEOUT_MS = 60 * 60_000

const e = env()

const deployments = new Worker<DeploymentJobData>(QUEUE_DEPLOYMENTS, async (job, token) => {
  const { deploymentId, projectId, environmentId } = job.data
  const lock = await acquireLock(redis(), deploymentLockKey(projectId, environmentId), LOCK_TTL_MS)
  if (!lock) {
    // Un autre déploiement est en cours sur ce projet/environnement : on repousse.
    await job.moveToDelayed(Date.now() + 5_000, token)
    throw new DelayedError()
  }
  const heartbeat = setInterval(() => void lock.extend(LOCK_TTL_MS), LOCK_TTL_MS / 3)
  const ctx = await createContext(deploymentId)
  await reportGithubDeployment(deploymentId, true)
  try {
    await Promise.race([
      runPipeline(ctx),
      new Promise((_, reject) => setTimeout(() => reject(new Error('Délai maximal du job dépassé')), JOB_TIMEOUT_MS).unref()),
    ])
  }
  catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    await ctx.log('system', message, 'error')
    if (!['FAILED', 'ROLLED_BACK', 'HEALTHY', 'DEGRADED', 'STOPPED', 'DELETED'].includes(ctx.status)) await ctx.transition('FAILED', message).catch(() => {})
    throw err
  }
  finally {
    clearInterval(heartbeat)
    await lock.release()
    await notifyDeploymentOutcome(deploymentId).catch(err => console.warn(`[notifications] ${err.message}`))
    await reportGithubDeployment(deploymentId)
  }
// Un job « bloqué » (worker arrêté en cours d'exécution) n'est jamais rejoué : un déploiement
// à moitié fait est clôturé en échec, puis relancé explicitement par l'utilisateur.
}, { connection: redis(), concurrency: e.WORKER_CONCURRENCY, maxStalledCount: 0 })

const maintenance = new Worker(QUEUE_MAINTENANCE, async (job) => {
  if (job.name === 'retention-purge') return purgeExpired(e.RETENTION_DAYS, job.data?.actor)
  if (job.name === 'server-health') return checkAllServers()
  if (job.name === 'proxy-routes-attach') return reattachProxyRoutes()
  if (job.name === 'uploads-purge') return { purged: await purgeStaleUploads(24) }
  if (job.name === 'webhook-delivery') return processWebhookDelivery(job.data.deliveryId, job.data.branch ?? null, { made: job.attemptsMade, max: job.opts.attempts ?? 1 })
  if (job.name === 'files-cleanup') return cleanupTargetTmp()
  if (job.name === 'deployments-recover') return recoverOrphanDeployments()
  if (job.name === 'watchtower-report') return handleReport(job.data.targetId, job.data.report)
  if (job.name === 'watchtower-profile-report') return handleProfileReport(job.data.profileId, job.data.report)
  if (job.name === 'targets-observe' || job.name === 'watchtower-reconcile') return observeAllTargets()
  if (job.name === 'image-overrides-bake') return bakeAllImageOverrides()
  if (job.name === 'nginx-certificates') return renewAllNginxCertificates()
  if (job.name === 'auto-rebuild') return runAutoRebuilds()
  if (job.name === 'github-connectors') return scanAllGithubConnectors()
  if (job.name === 'remediation-sync') return syncRemediationRequests()
  if (job.name === 'notification-digest') return runDigests()
}, { connection: redis(), concurrency: 1 })

// Analyses de vulnérabilités (Trivy) : une à la fois, longues (une image après l'autre).
const scans = new Worker(QUEUE_SCANS, async job => runTrivyScan(job.data ?? {}), { connection: redis(), concurrency: 1, lockDuration: 10 * 60_000 })
// Analyse interrompue (erreur, verrou perdu) : plus affichée « en cours », raison conservée.
scans.on('failed', (_job, err) => void failTrivyRun(err.message).catch(() => {}))

// Relevés de ressources : une file à part, un relevé à la fois.
const metrics = new Worker(QUEUE_METRICS, async () => sampleAll(), { connection: redis(), concurrency: 1, lockDuration: 2 * 60_000 })
metrics.on('failed', (_job, err) => console.warn(`[metrics] relevé impossible : ${err.message}`))

const notifications = new Worker(QUEUE_NOTIFICATIONS, async (job) => {
  if (job.name === 'dispatch') return { channels: await dispatchEvent(job.data.eventId) }
  if (job.name === 'deliver') return deliver(job.data.deliveryId, job.attemptsMade + 1)
}, { connection: redis(), concurrency: 4 })

// Purge quotidienne à 03:15.
await maintenanceQueue().upsertJobScheduler('retention-purge', { pattern: '15 3 * * *' }, { name: 'retention-purge' })
// Ressources des conteneurs déployés par la plateforme : un relevé par minute, règles d'alerte évaluées à chaque relevé.
await metricsQueue().upsertJobScheduler('metrics-sample', { every: 60_000 }, { name: 'metrics-sample' })
// Résumés périodiques des canaux en mode « résumé » : échéances vérifiées toutes les 15 minutes.
await maintenanceQueue().upsertJobScheduler('notification-digest', { every: 15 * 60_000 }, { name: 'notification-digest' })
// Contrôle des serveurs toutes les 5 minutes.
await maintenanceQueue().upsertJobScheduler('server-health', { every: 5 * 60_000 }, { name: 'server-health' })
// Conteneurs routés par le Traefik géré : rattachés au réseau du proxy après une recréation (30 s).
await maintenanceQueue().upsertJobScheduler('proxy-routes-attach', { every: 30_000 }, { name: 'proxy-routes-attach' })
// Archives déposées jamais utilisées : toutes les heures. Temporaires des serveurs cibles : chaque nuit.
await maintenanceQueue().upsertJobScheduler('uploads-purge', { pattern: '5 * * * *' }, { name: 'uploads-purge' })
await maintenanceQueue().upsertJobScheduler('files-cleanup', { pattern: '30 3 * * *' }, { name: 'files-cleanup' })
// Cibles déployées : images changées hors plateforme et santé des services, toutes les 5 minutes.
await maintenanceQueue().removeJobScheduler('watchtower-reconcile').catch(() => {})
await maintenanceQueue().upsertJobScheduler('targets-observe', { every: 5 * 60_000 }, { name: 'targets-observe' })

// Trivy : planification selon les réglages (chaque lundi à 03:00 par défaut).
await applyTrivySchedule().catch(err => console.warn(`[trivy] planification impossible : ${err.message}`))
// Demandes de correction (issues, PR) : état GitHub et résolution, toutes les 30 minutes.
await maintenanceQueue().upsertJobScheduler('remediation-sync', { every: 30 * 60_000 }, { name: 'remediation-sync' })
// Connecteurs GitHub : packages et artefacts relevés (GITHUB_SCAN_INTERVAL_MIN).
await maintenanceQueue().upsertJobScheduler('github-connectors', { every: e.GITHUB_SCAN_INTERVAL_MIN * 60_000 }, { name: 'github-connectors' })
// Reconstruction automatique : nouvelles versions des sources suivies (AUTO_REBUILD_INTERVAL_MIN).
await maintenanceQueue().upsertJobScheduler('auto-rebuild', { every: e.AUTO_REBUILD_INTERVAL_MIN * 60_000 }, { name: 'auto-rebuild' })
// Certificats nginx (Let's Encrypt par la console, certificats importés) : chaque jour à 04:10.
await maintenanceQueue().upsertJobScheduler('nginx-certificates', { pattern: '10 4 * * *' }, { name: 'nginx-certificates' })
// Images mises à niveau avant leur report automatique : écrites dans le Compose des projets, au démarrage.
await maintenanceQueue().add('image-overrides-bake', {}, { removeOnComplete: true, removeOnFail: true })
// Opérations orphelines : au démarrage, puis toutes les 2 minutes.
await maintenanceQueue().upsertJobScheduler('deployments-recover', { every: 2 * 60_000 }, { name: 'deployments-recover' })
deployments.on('failed', (job, err) => {
  if (job?.data.deploymentId) void failDeployment(job.data.deploymentId, `Opération interrompue : ${err.message}`).catch(() => {})
})

// Présence du worker, lue par /api/health.
const beat = async () => {
  await redis().set(WORKER_HEARTBEAT_KEY, JSON.stringify({ at: new Date().toISOString(), pid: process.pid, concurrency: e.WORKER_CONCURRENCY }), 'EX', 60).catch(() => {})
  // Témoin local pour le healthcheck du conteneur.
  await writeFile('/tmp/worker-alive', new Date().toISOString()).catch(() => {})
}
await beat()
const heartbeat = setInterval(beat, 20_000)

for (const w of [deployments, maintenance, notifications, scans]) {
  w.on('failed', (job, err) => console.error(`[${w.name}] job ${job?.id} en échec : ${err.message}`))
}

console.info(`Worker démarré (concurrence ${e.WORKER_CONCURRENCY})`)

async function shutdown() {
  clearInterval(heartbeat)
  await redis().del(WORKER_HEARTBEAT_KEY).catch(() => {})
  await Promise.all([deployments.close(), maintenance.close(), notifications.close(), scans.close(), metrics.close()])
  await closeRedis()
  await closeDb()
  process.exit(0)
}
process.on('SIGTERM', shutdown)
process.on('SIGINT', shutdown)
