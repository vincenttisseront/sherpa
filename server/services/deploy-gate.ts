/**
 * Porte de déploiement : fenêtres, planification et validation par une autre personne, par environnement.
 * Toute opération créée passe par `gateAndEnqueue` (seule porte d'entrée de la file de déploiement).
 * Une opération en attente de validation reste « en file » sans job (la cible est occupée) ; une opération planifiée
 * a un job différé. Annuler retire le job.
 */
import { eq } from 'drizzle-orm'
import { createError } from 'h3'
import type { DeployPolicyDto, DeployPolicyInput, GateInfoDto, GateStateDto } from '../../shared/schemas/deploy-gate'
import { isWindowOpen, nextWindowOpening } from '../../shared/utils/deploy-windows'
import { db, schema } from '../db/client'
import type { DeploymentOptions } from '../db/schema'
import { type GateDecision, type GatePolicy, decideGate } from '../lib/deploy-gate'
import { deploymentQueue, enqueueDeployment, type DeploymentJobData } from '../queue/queues'
import { audit } from '../utils/audit'
import type { AuthUser } from '../utils/auth'
import { canOn } from '../utils/auth'
import { appendLogs } from './logs'
import { emitNotification } from './notifications'

const DEFAULT_TZ = 'Europe/Paris'

export async function getPolicy(environmentId: string): Promise<GatePolicy> {
  const [p] = await db().select().from(schema.environmentPolicies).where(eq(schema.environmentPolicies.environmentId, environmentId))
  return { requireApproval: p?.requireApproval ?? false, timezone: p?.timezone ?? DEFAULT_TZ, windows: p?.windows ?? [] }
}

export async function listPolicies(): Promise<DeployPolicyDto[]> {
  const envs = await db().select().from(schema.environments)
  const policies = await db().select().from(schema.environmentPolicies)
  return envs.map((e) => {
    const p = policies.find(x => x.environmentId === e.id)
    return { environmentId: e.id, environment: e.name, isProduction: e.isProduction, requireApproval: p?.requireApproval ?? false, timezone: p?.timezone ?? DEFAULT_TZ, windows: p?.windows ?? [] }
  }).sort((a, b) => Number(a.isProduction) - Number(b.isProduction) || a.environment.localeCompare(b.environment))
}

export async function setPolicy(input: DeployPolicyInput, userId: string | null): Promise<void> {
  const [env] = await db().select({ id: schema.environments.id }).from(schema.environments).where(eq(schema.environments.id, input.environmentId))
  if (!env) throw createError({ statusCode: 404, statusMessage: 'Environnement introuvable' })
  const values = { environmentId: input.environmentId, requireApproval: input.requireApproval, timezone: input.timezone, windows: input.windows, updatedBy: userId }
  await db().insert(schema.environmentPolicies).values(values)
    .onConflictDoUpdate({ target: schema.environmentPolicies.environmentId, set: { ...values, updatedAt: new Date() } })
}

export async function gateInfo(environmentId: string): Promise<GateInfoDto> {
  const p = await getPolicy(environmentId)
  const now = new Date()
  return { requireApproval: p.requireApproval, timezone: p.timezone, windows: [...p.windows], open: isWindowOpen(p.windows, p.timezone, now), nextOpening: nextWindowOpening(p.windows, p.timezone, now)?.toISOString() ?? null }
}

/** Options de déploiement issues de la demande de planification (heure, urgence). */
export function scheduleOptions(s: { at?: string, urgent?: boolean } | undefined): DeploymentOptions {
  return { ...(s?.at ? { schedule: { at: s.at } } : {}), ...(s?.urgent ? { urgent: true } : {}) }
}

export function gateState(options: DeploymentOptions, requestedBy: string | null, decidedBy: string | null = null): GateStateDto {
  const a = options.approval
  return {
    approval: a ? { state: a.state, reason: a.reason, requestedAt: a.requestedAt, decidedBy, decidedAt: a.decidedAt ?? null, comment: a.comment ?? null } : null,
    scheduledFor: options.schedule?.at ?? null,
    requestedBy,
  }
}

const sys = (deploymentId: string, message: string, level: 'info' | 'warn' = 'info') => appendLogs(deploymentId, [{ phase: 'system', level, message }]).catch(() => [])
const fmt = (d: Date, tz: string) => d.toLocaleString('fr-FR', { timeZone: tz, dateStyle: 'full', timeStyle: 'short' })

async function cancelRow(deploymentId: string, message: string) {
  await db().update(schema.deployments).set({ status: 'CANCELLED', error: message.slice(0, 500), finishedAt: new Date() }).where(eq(schema.deployments.id, deploymentId))
}

interface Ctx { project: string, projectId: string, environment: string, environmentId: string, serverId: string, requestedByEmail: string | null }
async function contextOf(deploymentId: string): Promise<Ctx> {
  const [r] = await db().select({ project: schema.projects.name, projectId: schema.projects.id, environment: schema.environments.name, environmentId: schema.environments.id, serverId: schema.serverEndpoints.serverId, by: schema.users.email })
    .from(schema.deployments)
    .innerJoin(schema.projectTargets, eq(schema.projectTargets.id, schema.deployments.targetId))
    .innerJoin(schema.projects, eq(schema.projects.id, schema.projectTargets.projectId))
    .innerJoin(schema.environments, eq(schema.environments.id, schema.projectTargets.environmentId))
    .innerJoin(schema.serverEndpoints, eq(schema.serverEndpoints.id, schema.projectTargets.endpointId))
    .leftJoin(schema.users, eq(schema.users.id, schema.deployments.requestedBy))
    .where(eq(schema.deployments.id, deploymentId))
  return { project: r!.project, projectId: r!.projectId, environment: r!.environment, environmentId: r!.environmentId, serverId: r!.serverId, requestedByEmail: r!.by }
}

/** Seul point d'entrée vers la file de déploiement : applique la politique de l'environnement. */
export async function gateAndEnqueue(data: DeploymentJobData, idempotencyKey: string): Promise<void> {
  const [d] = await db().select().from(schema.deployments).where(eq(schema.deployments.id, data.deploymentId))
  if (!d) throw new Error('Déploiement introuvable')
  const policy = await getPolicy(data.environmentId)
  const now = new Date()
  const decision: GateDecision = decideGate(policy, {
    action: d.action, requestedBy: d.requestedBy, now, urgent: !!d.options.urgent,
    scheduledAt: d.options.schedule?.at ? new Date(d.options.schedule.at) : null,
  })

  if (decision.kind === 'refuse') {
    await cancelRow(d.id, decision.message)
    throw createError({ statusCode: decision.status, statusMessage: decision.message })
  }
  if (decision.kind === 'run') {
    await enqueueDeployment(data, idempotencyKey)
    return
  }
  const ctx = await contextOf(d.id)
  if (decision.kind === 'schedule') {
    await db().update(schema.deployments).set({ options: { ...d.options, schedule: { at: decision.at.toISOString() } } }).where(eq(schema.deployments.id, d.id))
    await enqueueDeployment(data, idempotencyKey, decision.at.getTime() - now.getTime())
    await sys(d.id, `Exécution planifiée : ${fmt(decision.at, policy.timezone)}${decision.automatic ? ' (prochaine ouverture de la fenêtre de déploiement)' : ''}`)
    await audit({ actorUserId: d.requestedBy, actorLabel: ctx.requestedByEmail ?? 'automatisme', action: 'deployment.schedule', targetType: 'deployment', targetId: d.id, projectId: ctx.projectId, environmentId: ctx.environmentId, serverId: ctx.serverId, outcome: 'success', details: { at: decision.at.toISOString(), automatic: !!decision.automatic } })
    return
  }
  // hold : validation par une autre personne requise, aucun job tant qu'elle n'est pas donnée.
  const approval = { state: 'pending' as const, reason: decision.reason, requestedAt: now.toISOString() }
  await db().update(schema.deployments).set({ options: { ...d.options, approval, ...(decision.at ? { schedule: { at: decision.at.toISOString() } } : {}) } }).where(eq(schema.deployments.id, d.id))
  await sys(d.id, `Validation requise (${decision.reason === 'urgent' ? 'demande urgente hors fenêtre de déploiement' : `politique de l'environnement ${ctx.environment}`}) : en attente d'une personne autorisée autre que le demandeur`, 'warn')
  await audit({ actorUserId: d.requestedBy, actorLabel: ctx.requestedByEmail ?? 'automatisme', action: 'deployment.approval_requested', targetType: 'deployment', targetId: d.id, projectId: ctx.projectId, environmentId: ctx.environmentId, serverId: ctx.serverId, outcome: 'success', details: { reason: decision.reason, action: d.action } })
  await emitNotification({
    event: 'deployment.approval', severity: 'warning',
    title: `Déploiement à valider — ${ctx.project} (${ctx.environment})`,
    summary: `${ctx.requestedByEmail ?? 'Un automatisme'} demande ${decision.reason === 'urgent' ? 'un déploiement urgent hors fenêtre' : 'un déploiement'} sur ${ctx.project} (${ctx.environment}) : une autre personne doit le valider.`,
    facts: [{ label: 'Projet', value: ctx.project }, { label: 'Environnement', value: ctx.environment }, { label: 'Opération', value: d.action }, { label: 'Demandé par', value: ctx.requestedByEmail ?? 'système' }],
    path: `/deployments/${d.id}`, serverId: ctx.serverId, environmentId: ctx.environmentId, projectId: ctx.projectId,
  })
}

/** Valider, refuser (une autre personne) ou annuler (opération en attente ou planifiée). */
export async function decide(deploymentId: string, user: AuthUser, decision: 'approve' | 'reject' | 'cancel', comment: string | null) {
  const [d] = await db().select().from(schema.deployments).where(eq(schema.deployments.id, deploymentId))
  if (!d) throw createError({ statusCode: 404, statusMessage: 'Déploiement introuvable' })
  const ctx = await contextOf(deploymentId)
  const scope = { projectId: ctx.projectId, environmentId: ctx.environmentId, serverId: ctx.serverId }
  const pending = d.options.approval?.state === 'pending'
  const scheduled = !!d.options.schedule && d.status === 'QUEUED'
  const audited = (action: string, extra: Record<string, unknown> = {}) => audit({ actorUserId: user.id, actorLabel: user.email, action, targetType: 'deployment', targetId: deploymentId, ...scope, outcome: 'success', details: { comment, ...extra } })
  const finish = async (status: 'CANCELLED', message: string) => {
    await db().update(schema.deployments).set({ status, error: message.slice(0, 500), finishedAt: new Date(), options: { ...d.options, ...(d.options.approval ? { approval: { ...d.options.approval, state: decision === 'reject' ? 'rejected' as const : d.options.approval.state, decidedBy: user.id, decidedAt: new Date().toISOString(), comment } } : {}) } }).where(eq(schema.deployments.id, deploymentId))
    await sys(deploymentId, message, 'warn')
  }

  if (decision === 'cancel') {
    if (d.status !== 'QUEUED' || !(pending || scheduled)) throw createError({ statusCode: 409, statusMessage: 'Seule une opération en attente de validation ou planifiée peut être annulée' })
    if (d.requestedBy !== user.id && !canOn(user, 'deployment:approve', scope) && !canOn(user, 'policy:manage', scope)) throw createError({ statusCode: 403, statusMessage: 'Seul le demandeur ou un valideur peut annuler' })
    await (await deploymentQueue().getJob(d.idempotencyKey))?.remove().catch(() => undefined)
    await finish('CANCELLED', `Annulé par ${user.email}${comment ? ` : ${comment}` : ''}`)
    await audited('deployment.cancel')
    return { status: 'CANCELLED' as const }
  }

  if (!pending) throw createError({ statusCode: 409, statusMessage: 'Ce déploiement n\'attend pas de validation' })
  if (d.requestedBy && d.requestedBy === user.id) throw createError({ statusCode: 409, statusMessage: 'La validation doit venir d\'une autre personne que le demandeur' })

  if (decision === 'reject') {
    await finish('CANCELLED', `Refusé par ${user.email}${comment ? ` : ${comment}` : ''}`)
    await audited('deployment.reject')
  }
  else {
    const at = d.options.schedule?.at ? new Date(d.options.schedule.at) : null
    await db().update(schema.deployments).set({ options: { ...d.options, approval: { ...d.options.approval!, state: 'approved', decidedBy: user.id, decidedAt: new Date().toISOString(), comment } } }).where(eq(schema.deployments.id, deploymentId))
    const delay = at ? Math.max(0, at.getTime() - Date.now()) : 0
    await enqueueDeployment({ deploymentId, projectId: ctx.projectId, environmentId: ctx.environmentId }, d.idempotencyKey, delay)
    await sys(deploymentId, `Validé par ${user.email}${comment ? ` : ${comment}` : ''}${delay ? ` — exécution planifiée à l'heure demandée` : ''}`)
    await audited('deployment.approve')
  }
  await emitNotification({
    event: 'deployment.approval', severity: 'info',
    title: `Déploiement ${decision === 'approve' ? 'validé' : 'refusé'} — ${ctx.project} (${ctx.environment})`,
    summary: `${user.email} a ${decision === 'approve' ? 'validé' : 'refusé'} le déploiement demandé par ${ctx.requestedByEmail ?? 'un automatisme'}${comment ? ` : ${comment}` : ''}.`,
    facts: [{ label: 'Projet', value: ctx.project }, { label: 'Environnement', value: ctx.environment }, { label: 'Décision de', value: user.email }],
    path: `/deployments/${deploymentId}`, serverId: ctx.serverId, environmentId: ctx.environmentId, projectId: ctx.projectId,
  })
  return { status: decision === 'approve' ? 'QUEUED' as const : 'CANCELLED' as const }
}
