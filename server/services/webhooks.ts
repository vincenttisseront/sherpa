/**
 * Déploiement au push GitHub (webhook) :
 * - un webhook par projet : secret chiffré (affiché une seule fois), livraisons signées en HMAC-SHA256 ;
 * - par environnement : activé ou non, branche suivie (sinon celle de la source du projet) ;
 * - livraison valide → environnements concernés → reconstruction sur le dernier commit (même chemin
 *   que « Reconstruire »), en attente si un déploiement est déjà en cours sur la cible ;
 * - statut publié sur GitHub (API Deployments) : « déployé en staging » visible sur le commit et les PR.
 */
import { randomBytes } from 'node:crypto'
import { and, desc, eq, inArray, notInArray, sql } from 'drizzle-orm'
import { createError } from 'h3'
import type { ProjectWebhookDto, TargetWebhookInput, WebhookDeliveryDto, WebhookTargetResult } from '../../shared/schemas/webhook'
import { ACTIVE_STATUSES } from '../../shared/utils/deployment-status'
import { db, schema } from '../db/client'
import { GithubError } from '../lib/github'
import { type SourceInfo, type WebhookTargetInfo, effectiveBranch, githubStateOf, parseEvent, selectTargets, verifySignature } from '../lib/webhook'
import { maintenanceQueue } from '../queue/queues'
import { audit } from '../utils/audit'
import { decryptSecret, encryptSecret } from '../utils/crypto'
import { env } from '../utils/env'
import { type TargetRow, getTargetOr404, targetScope } from './projects'
import { emitNotification } from './notifications'
import { rebuildPlan, startRebuild } from './rebuild'
import { getProjectSource, github, githubCredentials } from './sources'

const KEEP_DELIVERIES = 100
const MAX_ATTEMPTS = 40
const RETRY_MS = 30_000
const ACTOR = 'webhook GitHub'

export const webhookUrl = (projectId: string) => `${env().APP_URL}/api/webhooks/github/${projectId}`

async function targetInfos(projectId: string): Promise<(WebhookTargetInfo & { environmentName: string, isProduction: boolean, webhook: TargetWebhookInput | null })[]> {
  const rows = await db().select({ id: schema.projectTargets.id, webhook: schema.projectTargets.webhook, key: schema.environments.key, name: schema.environments.name, prod: schema.environments.isProduction })
    .from(schema.projectTargets)
    .innerJoin(schema.environments, eq(schema.environments.id, schema.projectTargets.environmentId))
    .where(eq(schema.projectTargets.projectId, projectId))
  return rows.map(r => ({ targetId: r.id, environment: r.key, environmentName: r.name, isProduction: r.prod, enabled: !!r.webhook?.enabled, branch: r.webhook?.branch ?? null, webhook: r.webhook ?? null }))
}

const sourceInfo = (s: Awaited<ReturnType<typeof getProjectSource>>): SourceInfo | null => (s?.kind === 'github' ? { repository: s.repository, refType: s.refType, ref: s.ref } : null)

const toDelivery = (d: typeof schema.webhookDeliveries.$inferSelect): WebhookDeliveryDto => ({ id: d.id, guid: d.guid, event: d.event, ref: d.ref, sha: d.sha, outcome: d.outcome, detail: d.detail, results: d.results, createdAt: d.createdAt.toISOString() })

export async function getProjectWebhook(projectId: string): Promise<ProjectWebhookDto> {
  const [wh] = await db().select().from(schema.projectWebhooks).where(eq(schema.projectWebhooks.projectId, projectId))
  const source = await getProjectSource(projectId)
  const info = sourceInfo(source)
  const targets = await targetInfos(projectId)
  const deliveries = await db().select().from(schema.webhookDeliveries).where(eq(schema.webhookDeliveries.projectId, projectId)).orderBy(desc(schema.webhookDeliveries.createdAt)).limit(20)
  return {
    url: webhookUrl(projectId),
    configured: !!wh,
    createdAt: wh?.createdAt.toISOString() ?? null,
    lastDeliveryAt: wh?.lastDeliveryAt?.toISOString() ?? null,
    github: info?.repository ? { repository: info.repository, refType: info.refType, ref: info.ref } : null,
    statusReporting: info ? (source?.tokenSecretId ? 'token' : 'no-token') : 'none',
    targets: targets.map(t => ({ targetId: t.targetId, environment: t.environment, environmentName: t.environmentName, isProduction: t.isProduction, webhook: t.webhook, effectiveBranch: effectiveBranch(t, info) })),
    deliveries: deliveries.map(toDelivery),
  }
}

/** Génère (ou remplace) le secret du webhook : renvoyé UNE fois, jamais relisible. */
export async function rotateWebhookSecret(projectId: string): Promise<{ secret: string }> {
  const secret = randomBytes(32).toString('hex')
  const { envelope, keyId } = encryptSecret(secret)
  await db().transaction(async (tx) => {
    const [sec] = await tx.insert(schema.secrets).values({ purpose: 'webhook_secret', envelope, keyId }).returning({ id: schema.secrets.id })
    const [prev] = await tx.select({ secretId: schema.projectWebhooks.secretId }).from(schema.projectWebhooks).where(eq(schema.projectWebhooks.projectId, projectId))
    if (prev) {
      await tx.update(schema.projectWebhooks).set({ secretId: sec!.id, rotatedAt: new Date() }).where(eq(schema.projectWebhooks.projectId, projectId))
      await tx.delete(schema.secrets).where(eq(schema.secrets.id, prev.secretId))
    }
    else {
      await tx.insert(schema.projectWebhooks).values({ projectId, secretId: sec!.id })
    }
  })
  return { secret }
}

export async function deleteProjectWebhook(projectId: string): Promise<void> {
  await db().transaction(async (tx) => {
    const [prev] = await tx.select({ secretId: schema.projectWebhooks.secretId }).from(schema.projectWebhooks).where(eq(schema.projectWebhooks.projectId, projectId))
    if (!prev) return
    await tx.delete(schema.projectWebhooks).where(eq(schema.projectWebhooks.projectId, projectId))
    await tx.delete(schema.secrets).where(eq(schema.secrets.id, prev.secretId))
  })
}

export async function setTargetWebhook(t: TargetRow, input: TargetWebhookInput): Promise<TargetWebhookInput> {
  if (input.enabled) {
    const source = await getProjectSource(t.project.id)
    if (source?.kind !== 'github' || !source.repository) throw createError({ statusCode: 422, statusMessage: 'Le projet ne suit pas de dépôt GitHub : rien à déclencher.' })
    if (!effectiveBranch(input, sourceInfo(source)) && source.refType !== 'tag') throw createError({ statusCode: 422, statusMessage: 'Préciser la branche suivie par cet environnement (la source du projet ne suit pas de branche).' })
  }
  await db().update(schema.projectTargets).set({ webhook: input }).where(eq(schema.projectTargets.id, t.target.id))
  return input
}

export interface HandledDelivery { status: number, body: Record<string, unknown> }

/** Livraison reçue sur l'URL publique : signature, doublon, évènement, environnements concernés. */
export async function handleDelivery(projectId: string, input: { guid: string, event: string, signature: string | undefined, raw: string }): Promise<HandledDelivery> {
  const [wh] = await db().select().from(schema.projectWebhooks).where(eq(schema.projectWebhooks.projectId, projectId))
  if (!wh) return { status: 404, body: { error: 'Introuvable' } }
  const [sec] = await db().select({ envelope: schema.secrets.envelope }).from(schema.secrets).where(eq(schema.secrets.id, wh.secretId))
  if (!sec || !verifySignature(decryptSecret(sec.envelope), input.raw, input.signature)) return { status: 401, body: { error: 'Signature invalide' } }

  let body: unknown
  try {
    body = JSON.parse(input.raw)
  }
  catch {
    return { status: 400, body: { error: 'Charge utile illisible' } }
  }
  const guid = /^[\w-]{8,64}$/.test(input.guid) ? input.guid : randomBytes(12).toString('hex')
  const [dup] = await db().select({ id: schema.webhookDeliveries.id }).from(schema.webhookDeliveries).where(and(eq(schema.webhookDeliveries.projectId, projectId), eq(schema.webhookDeliveries.guid, guid)))
  if (dup) return { status: 200, body: { duplicate: true } }

  const event = parseEvent(input.event, body)
  const source = await getProjectSource(projectId)
  const selection = selectTargets(event, sourceInfo(source), await targetInfos(projectId))
  const ref = event.kind === 'push' ? event.branch : event.kind === 'release' ? event.tag : null
  const sha = event.kind === 'push' ? event.sha : null
  await db().update(schema.projectWebhooks).set({ lastDeliveryAt: new Date() }).where(eq(schema.projectWebhooks.id, wh.id))
  const record = async (outcome: 'done' | 'ignored' | 'accepted', detail: string | null, results: WebhookTargetResult[] = []) => {
    const [row] = await db().insert(schema.webhookDeliveries).values({ projectId, guid, event: input.event.slice(0, 40), ref: ref?.slice(0, 250) ?? null, sha, outcome, detail, results }).returning({ id: schema.webhookDeliveries.id })
    // Historique borné : les plus récentes livraisons seulement.
    const keep = db().select({ id: schema.webhookDeliveries.id }).from(schema.webhookDeliveries).where(eq(schema.webhookDeliveries.projectId, projectId)).orderBy(desc(schema.webhookDeliveries.createdAt)).limit(KEEP_DELIVERIES)
    await db().delete(schema.webhookDeliveries).where(and(eq(schema.webhookDeliveries.projectId, projectId), notInArray(schema.webhookDeliveries.id, keep)))
    return row!.id
  }

  if (selection.action === 'pong') {
    await record('done', 'Ping : le webhook est correctement configuré')
    return { status: 200, body: { pong: true } }
  }
  if (selection.action === 'ignore') {
    await record('ignored', selection.reason)
    return { status: 200, body: { ignored: selection.reason } }
  }
  const id = await record('accepted', null, selection.targets.map(t => ({ targetId: t.targetId, environment: t.environment, outcome: 'waiting' as const })))
  await maintenanceQueue().add('webhook-delivery', { deliveryId: id, branch: selection.branch }, { attempts: MAX_ATTEMPTS, backoff: { type: 'fixed', delay: RETRY_MS }, removeOnComplete: 200, removeOnFail: 500 })
  return { status: 202, body: { accepted: true, environments: selection.targets.map(t => t.environment) } }
}

/** Travail du worker : déploie chaque environnement de la livraison ; relancé tant qu'une cible est occupée. */
export async function processWebhookDelivery(deliveryId: string, branch: string | null, attempt: { made: number, max: number }): Promise<void> {
  const [d] = await db().select().from(schema.webhookDeliveries).where(eq(schema.webhookDeliveries.id, deliveryId))
  if (!d) return
  const results = [...d.results]
  const lastTry = attempt.made + 1 >= attempt.max
  for (const [i, r] of results.entries()) {
    if (r.outcome !== 'waiting') continue
    try {
      results[i] = await deployTarget(r, d, branch, lastTry)
    }
    catch (err) {
      results[i] = { ...r, outcome: 'error', message: (((err as { statusMessage?: string }).statusMessage ?? (err as Error).message) || 'Erreur').slice(0, 300) }
    }
  }
  const waiting = results.some(r => r.outcome === 'waiting')
  const outcome = waiting ? 'accepted' : results.every(r => r.outcome === 'error') ? 'error' : 'done'
  await db().update(schema.webhookDeliveries).set({ results, outcome, updatedAt: new Date() }).where(eq(schema.webhookDeliveries.id, deliveryId))
  if (waiting) throw new Error('Déploiement déjà en cours sur au moins un environnement : nouvelle tentative')
}

async function deployTarget(r: WebhookTargetResult, d: typeof schema.webhookDeliveries.$inferSelect, branch: string | null, lastTry: boolean): Promise<WebhookTargetResult> {
  const t = await getTargetOr404(r.targetId)
  const base = { targetId: r.targetId, environment: r.environment }
  if (t.project.archivedAt || !t.target.webhook?.enabled) return { ...base, outcome: 'skipped', message: t.project.archivedAt ? 'Projet archivé' : 'Déploiement au push désactivé entre-temps' }
  const busy = await db().$count(schema.deployments, and(eq(schema.deployments.targetId, r.targetId), inArray(schema.deployments.status, [...ACTIVE_STATUSES])))
  if (busy) return lastTry ? { ...base, outcome: 'error', message: 'Un déploiement est resté en cours trop longtemps' } : { ...base, outcome: 'waiting', message: 'Déploiement en cours : en attente' }
  const plan = await rebuildPlan(t, branch)
  if (plan.upToDate || !plan.latest || plan.mode === 'same') return { ...base, outcome: 'up-to-date', message: `Déjà à jour : ${plan.current?.label ?? plan.latest?.label ?? ''}`.trim() }
  const started = await startRebuild(t, { cleanBuild: t.target.webhook.cleanBuild, userId: null, idempotencyKey: `webhook:${d.id}:${r.targetId}`, branch })
  await audit({ actorUserId: null, actorLabel: ACTOR, action: 'target.rebuild', targetType: 'deployment', targetId: started.deploymentId, ...targetScope(t), outcome: 'success', details: { webhook: true, event: d.event, ref: d.ref, from: plan.current?.label ?? null, to: plan.latest.label } })
  await announceOnGithub(t, started.deploymentId, d.sha ?? plan.latest.ref, plan.latest.label)
  await emitNotification({
    event: 'rebuild.auto', severity: 'info', title: `Déploiement au push : ${t.project.name} (${t.env.name})`, summary: `${plan.latest.label} reçu de GitHub : reconstruction et déploiement lancés.`, path: `/deployments/${started.deploymentId}`,
    facts: [{ label: 'Projet', value: t.project.name }, { label: 'Environnement', value: t.env.name }, { label: 'Version', value: `${plan.current?.label ?? '?'} → ${plan.latest.label}` }],
    serverId: t.server.id, environmentId: t.env.id, projectId: t.project.id,
  }).catch(() => {})
  return { ...base, outcome: 'started', deploymentId: started.deploymentId, message: plan.latest.label }
}

// --- Statut publié sur GitHub (API Deployments) ---

/** Crée le déploiement GitHub (commit, environnement) et publie « en file » ; sans jeton ou sans droit, le déploiement n'en souffre pas. */
async function announceOnGithub(t: TargetRow, deploymentId: string, ref: string, label: string): Promise<void> {
  try {
    const source = await getProjectSource(t.project.id)
    if (source?.kind !== 'github' || !source.tokenSecretId) return
    const src = await githubCredentials(source)
    const { id } = await github().createDeployment(src, { ref, environment: t.env.key, description: `Sherpa : ${label}`, production: t.env.isProduction })
    const exposure = t.target.exposures[0]
    const environmentUrl = exposure ? `https://${exposure.host}${exposure.pathPrefix ?? ''}` : undefined
    await db().update(schema.deployments).set({ options: sql`${schema.deployments.options} || ${JSON.stringify({ githubDeployment: { apiUrl: source.apiUrl, repository: src.repository, id, ...(environmentUrl ? { environmentUrl } : {}) } })}::jsonb` }).where(eq(schema.deployments.id, deploymentId))
    // État réel à cet instant (le worker a pu démarrer avant l'enregistrement de l'identifiant GitHub).
    await reportGithubDeployment(deploymentId)
  }
  catch (err) {
    console.warn(`[webhook] statut GitHub non publié : ${err instanceof GithubError ? err.message : (err as Error).message}`)
  }
}

/** Publie l'état courant d'un déploiement sur son déploiement GitHub (s'il en a un). Sans effet sinon. */
export async function reportGithubDeployment(deploymentId: string, started = false): Promise<void> {
  const [d] = await db().select({ status: schema.deployments.status, options: schema.deployments.options, targetId: schema.deployments.targetId }).from(schema.deployments).where(eq(schema.deployments.id, deploymentId))
  const gh = d?.options?.githubDeployment
  if (!d || !gh) return
  const mapped = started ? { state: 'in_progress' as const, description: 'Déploiement en cours' } : githubStateOf(d.status)
  if (!mapped) return
  try {
    const [row] = await db().select({ projectId: schema.projectTargets.projectId }).from(schema.projectTargets).where(eq(schema.projectTargets.id, d.targetId))
    const source = row ? await getProjectSource(row.projectId) : null
    if (source?.kind !== 'github') return
    const src = await githubCredentials(source)
    const environmentUrl = gh.environmentUrl
    await github().createDeploymentStatus({ ...src, repository: gh.repository, apiUrl: gh.apiUrl }, gh.id, { state: mapped.state, description: mapped.description, logUrl: `${env().APP_URL}/deployments/${deploymentId}`, environmentUrl: mapped.state === 'success' ? environmentUrl : undefined })
  }
  catch (err) {
    console.warn(`[webhook] statut GitHub non publié : ${err instanceof GithubError ? err.message : (err as Error).message}`)
  }
}
