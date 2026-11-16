/**
 * Reprise après incident : une opération dont le job a disparu (worker arrêté
 * en pleine exécution, Redis vidé, job en échec sans mise à jour du statut)
 * resterait « en cours » et bloquerait sa cible. Elle est clôturée en échec,
 * journalisée, auditée et notifiée.
 */
import { and, eq, inArray, lt } from 'drizzle-orm'
import { ACTIVE_STATUSES, type DeploymentStatus } from '../../shared/utils/deployment-status'
import { db, schema } from '../db/client'
import { deploymentQueue } from '../queue/queues'
import { appendLogs } from '../services/logs'
import { audit } from '../utils/audit'
import { notifyDeploymentOutcome } from '../services/deployment-notify'
import { reportGithubDeployment } from '../services/webhooks'

/** Délai minimal avant de considérer une opération sans job comme orpheline. */
const GRACE_MS = 2 * 60_000

export async function failDeployment(deploymentId: string, reason: string): Promise<boolean> {
  const [d] = await db().select().from(schema.deployments).where(eq(schema.deployments.id, deploymentId))
  if (!d || !ACTIVE_STATUSES.includes(d.status)) return false
  const to: DeploymentStatus = d.status === 'VALIDATING' ? 'VALIDATION_FAILED' : 'FAILED'
  const r = await db().update(schema.deployments)
    // failed_from reste vide : une interruption n'est pas un échec de build (statut d'origine dans le log et l'audit).
    .set({ status: to, error: reason, finishedAt: new Date() })
    // Garde : rien n'a changé entre-temps.
    .where(and(eq(schema.deployments.id, deploymentId), eq(schema.deployments.status, d.status)))
    .returning({ id: schema.deployments.id })
  if (!r.length) return false
  await appendLogs(deploymentId, [{ phase: 'system', level: 'error', message: `${reason} (statut au moment de l'interruption : ${d.status})` }])
  await audit({ actorLabel: 'system', action: 'deployment.recovered', targetType: 'deployment', targetId: deploymentId, outcome: 'failure', details: { from: d.status, reason } })
  await notifyDeploymentOutcome(deploymentId).catch(() => {})
  await reportGithubDeployment(deploymentId)
  return true
}

/** Clôt les opérations actives dont le job n'existe plus ou n'est plus en cours. */
export async function recoverOrphanDeployments(): Promise<{ checked: number, recovered: number }> {
  const active = (await db().select({ id: schema.deployments.id, key: schema.deployments.idempotencyKey, status: schema.deployments.status, options: schema.deployments.options })
    .from(schema.deployments)
    .where(and(inArray(schema.deployments.status, [...ACTIVE_STATUSES]), lt(schema.deployments.updatedAt, new Date(Date.now() - GRACE_MS)))))
    // En attente de validation : aucun job tant qu'une autre personne ne l'a pas donnée (pas une opération orpheline).
    .filter(d => d.options?.approval?.state !== 'pending')
  let recovered = 0
  for (const d of active) {
    const job = await deploymentQueue().getJob(d.key)
    const state = job ? await job.getState() : 'missing'
    if (['active', 'waiting', 'delayed', 'prioritized', 'waiting-children'].includes(state)) continue
    const reason = state === 'missing'
      ? 'Opération interrompue : son job a disparu (redémarrage ou perte de la file)'
      : `Opération interrompue : le worker s'est arrêté pendant l'exécution (job ${state})`
    if (await failDeployment(d.id, reason)) recovered++
  }
  return { checked: active.length, recovered }
}
