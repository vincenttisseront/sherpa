/** Notification de l'issue d'un déploiement ou d'une action de cycle de vie (§18). */
import { eq } from 'drizzle-orm'
import type { NotificationEvent } from '../../shared/schemas/notifications'
import { db, schema } from '../db/client'
import { emitNotification } from './notifications'

const ACTION_LABEL: Record<string, string> = { deploy: 'Déploiement', redeploy: 'Redéploiement', stop: 'Arrêt', start: 'Démarrage', restart: 'Redémarrage', delete: 'Suppression', rollback: 'Rollback', migrate: 'Migration' }

export async function notifyDeploymentOutcome(deploymentId: string): Promise<void> {
  const [r] = await db().select({
    d: schema.deployments,
    project: { id: schema.projects.id, name: schema.projects.name },
    env: { id: schema.environments.id, name: schema.environments.name, isProduction: schema.environments.isProduction },
    serverId: schema.serverEndpoints.serverId,
    release: schema.releases.number,
    by: schema.users.email,
  }).from(schema.deployments)
    .innerJoin(schema.projectTargets, eq(schema.projectTargets.id, schema.deployments.targetId))
    .innerJoin(schema.projects, eq(schema.projects.id, schema.projectTargets.projectId))
    .innerJoin(schema.environments, eq(schema.environments.id, schema.projectTargets.environmentId))
    .innerJoin(schema.serverEndpoints, eq(schema.serverEndpoints.id, schema.projectTargets.endpointId))
    .leftJoin(schema.releases, eq(schema.releases.id, schema.deployments.releaseId))
    .leftJoin(schema.users, eq(schema.users.id, schema.deployments.requestedBy))
    .where(eq(schema.deployments.id, deploymentId))
  if (!r) return
  const { d } = r
  const deployLike = d.action === 'deploy' || d.action === 'redeploy' || d.action === 'rollback'
  let event: NotificationEvent | null = null
  let severity: 'info' | 'warning' | 'error' = 'info'
  if (d.status === 'HEALTHY' && deployLike) event = 'deployment.succeeded'
  else if (d.status === 'DEGRADED') [event, severity] = ['healthcheck.degraded', 'warning']
  else if (d.status === 'ROLLED_BACK') [event, severity] = ['deployment.rolled_back', 'warning']
  else if (d.status === 'FAILED' || d.status === 'VALIDATION_FAILED') [event, severity] = [d.failedFrom === 'BUILDING' ? 'build.failed' : 'deployment.failed', 'error']
  if (!event) return

  const what = `${ACTION_LABEL[d.action] ?? d.action} de ${r.project.name} (${r.env.name})`
  const TITLE: Record<NotificationEvent, string> = {
    'deployment.succeeded': `${what} réussi`,
    'build.failed': `Échec du build — ${r.project.name} (${r.env.name})`,
    'deployment.failed': `${what} en échec`,
    'healthcheck.degraded': `${r.project.name} (${r.env.name}) dégradé`,
    'deployment.rolled_back': `Rollback — ${r.project.name} (${r.env.name})`,
    'server.unavailable': '', 'watchtower.error': '', 'user.invited': '', 'permissions.changed': '', 'rebuild.auto': '', 'github.alert': '', 'vulnerability.found': '', 'resource.alert': '', 'deployment.approval': '', 'digest.summary': '',
  }
  const duration = d.startedAt && d.finishedAt ? `${Math.round((d.finishedAt.getTime() - d.startedAt.getTime()) / 1000)} s` : null
  await emitNotification({
    event,
    severity: r.env.isProduction && severity === 'warning' ? 'error' : severity,
    title: TITLE[event],
    summary: d.error ?? (event === 'deployment.succeeded' ? 'Tous les services sont démarrés et sains.' : 'Voir les logs du déploiement.'),
    facts: [
      { label: 'Projet', value: r.project.name },
      { label: 'Environnement', value: r.env.name },
      ...(r.release ? [{ label: 'Release', value: `#${r.release}` }] : []),
      { label: 'Demandé par', value: r.by ?? 'système' },
      ...(duration ? [{ label: 'Durée', value: duration }] : []),
    ],
    path: `/deployments/${d.id}`,
    projectId: r.project.id,
    environmentId: r.env.id,
    serverId: r.serverId,
  })
}
