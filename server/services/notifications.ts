/**
 * Notifications (§18) : le moteur émet des évènements ; chaque canal abonné
 * reçoit un envoi suivi (statut, tentatives, erreur), avec reprises.
 *
 * Filtre d'environnement d'un canal : il ne s'applique qu'aux évènements qui
 * portent un environnement (un serveur indisponible concerne tout le monde).
 */
import { and, asc, count, desc, eq, gte, ilike, inArray, lte, or, type SQL } from 'drizzle-orm'
import { UnrecoverableError } from 'bullmq'
import type { Paginated, TableQuery } from '../../shared/schemas/common'
import { type ChannelDto, type ChannelInput, type DeliveryDto, type NotificationEvent, discordConfig, emailConfig, gotifyConfig, ntfyConfig, slackConfig, teamsGraphConfig, teamsWebhookConfig } from '../../shared/schemas/notifications'
import { type NotificationMessage, NotificationError, notificationAdapter } from '../adapters/notifications'
import { checkWebhookUrl } from '../adapters/notifications/teams-webhook'
import { smtpConfigured } from '../adapters/notifications/email'
import { db, schema } from '../db/client'
import { composeDigest, digestDue, withNarrative } from '../lib/digest'
import { notificationQueue } from '../queue/queues'
import { decryptSecret, encryptSecret } from '../utils/crypto'
import { env } from '../utils/env'
import { redactPatterns } from '../utils/redact'
import { narrateDigest, type NarrativeMemo } from './ai-digest'
import { periodRange } from '../utils/table'

export interface EmitInput extends Omit<NotificationMessage, 'link'> {
  /** Chemin dans la plateforme (ex. /deployments/…) ; l'URL complète est construite ici. */
  path?: string | null
  serverId?: string | null
  environmentId?: string | null
  projectId?: string | null
}

const DELIVERY_ATTEMPTS = 4

/** Émet un évènement. Ne lève jamais : une notification ne doit pas faire échouer l'opération. */
export async function emitNotification(input: EmitInput): Promise<string | null> {
  try {
    const [ev] = await db().insert(schema.notificationEvents).values({
      event: input.event,
      severity: input.severity,
      title: redactPatterns(input.title).slice(0, 300),
      summary: redactPatterns(input.summary).slice(0, 4000),
      facts: input.facts.map(f => ({ label: f.label, value: redactPatterns(f.value).slice(0, 500) })),
      link: input.path ? `${env().APP_URL}${input.path}` : null,
      serverId: input.serverId ?? null,
      environmentId: input.environmentId ?? null,
      projectId: input.projectId ?? null,
    }).returning({ id: schema.notificationEvents.id })
    await notificationQueue().add('dispatch', { eventId: ev!.id })
    return ev!.id
  }
  catch (err) {
    console.warn(`[notifications] émission impossible (${input.event}) : ${(err as Error).message}`)
    return null
  }
}

/** Crée un envoi par canal abonné et les met en file. */
export async function dispatchEvent(eventId: string): Promise<number> {
  const [ev] = await db().select().from(schema.notificationEvents).where(eq(schema.notificationEvents.id, eventId))
  if (!ev) return 0
  const channels = (await db().select().from(schema.notificationChannels).where(eq(schema.notificationChannels.enabled, true)))
    // Les canaux en mode résumé reçoivent un récapitulatif périodique, pas chaque évènement.
    .filter(c => c.digest === 'off' && c.events.includes(ev.event) && (!ev.environmentId || !c.environmentIds.length || c.environmentIds.includes(ev.environmentId)))
  for (const c of channels) {
    const [d] = await db().insert(schema.notificationDeliveries).values({ eventId, channelId: c.id, channelName: c.name, kind: c.kind }).returning({ id: schema.notificationDeliveries.id })
    await notificationQueue().add('deliver', { deliveryId: d!.id }, { attempts: DELIVERY_ATTEMPTS, backoff: { type: 'exponential', delay: 5_000 } })
  }
  return channels.length
}

async function channelConfig(c: typeof schema.notificationChannels.$inferSelect): Promise<unknown> {
  const [s] = await db().select({ envelope: schema.secrets.envelope }).from(schema.secrets).where(eq(schema.secrets.id, c.configSecretId))
  if (!s) throw new NotificationError('Configuration du canal introuvable', false)
  return JSON.parse(decryptSecret(s.envelope))
}

const messageOf = (ev: typeof schema.notificationEvents.$inferSelect): NotificationMessage => ({
  event: ev.event as NotificationEvent, title: ev.title, summary: ev.summary, severity: ev.severity as NotificationMessage['severity'], facts: ev.facts, link: ev.link,
})

/** Un envoi ; lève pour une reprise, UnrecoverableError si inutile de réessayer. */
export async function deliver(deliveryId: string, attempt: number): Promise<void> {
  const [d] = await db().select().from(schema.notificationDeliveries).where(eq(schema.notificationDeliveries.id, deliveryId))
  if (!d || d.status === 'sent') return
  const [ev] = await db().select().from(schema.notificationEvents).where(eq(schema.notificationEvents.id, d.eventId))
  const [c] = d.channelId ? await db().select().from(schema.notificationChannels).where(eq(schema.notificationChannels.id, d.channelId)) : []
  const fail = async (message: string, final: boolean) => {
    await db().update(schema.notificationDeliveries).set({ attempts: attempt, error: redactPatterns(message).slice(0, 1000), ...(final ? { status: 'failed' } : {}) }).where(eq(schema.notificationDeliveries.id, deliveryId))
  }
  if (!ev || !c) {
    await fail('Canal ou évènement supprimé', true)
    return
  }
  try {
    await notificationAdapter(c.kind).send(await channelConfig(c), messageOf(ev))
    await db().update(schema.notificationDeliveries).set({ status: 'sent', attempts: attempt, error: null, sentAt: new Date() }).where(eq(schema.notificationDeliveries.id, deliveryId))
  }
  catch (err) {
    const retryable = !(err instanceof NotificationError) || err.retryable
    const final = !retryable || attempt >= DELIVERY_ATTEMPTS
    await fail((err as Error).message, final)
    if (!final) throw err
    throw new UnrecoverableError((err as Error).message)
  }
}

// ---------------------------------------------------------------------------
// Canaux
// ---------------------------------------------------------------------------

/** Contrôles propres au type de canal ; renvoie les erreurs par champ. */
export function checkChannelConfig(kind: ChannelInput['kind'], config: unknown): Record<string, string> {
  if (kind === 'email') {
    if (!smtpConfigured()) return { kind: 'SMTP non configuré sur cette instance (SMTP_HOST)' }
    const r = emailConfig.safeParse(config)
    return r.success ? {} : { 'config.recipients': r.error.issues[0]!.message }
  }
  if (kind === 'teams_webhook' || kind === 'slack_webhook' || kind === 'discord_webhook') {
    const r = (kind === 'teams_webhook' ? teamsWebhookConfig : kind === 'slack_webhook' ? slackConfig : discordConfig).safeParse(config)
    if (!r.success) return { 'config.url': r.error.issues[0]!.message }
    const problem = checkWebhookUrl(r.data.url)
    return problem ? { 'config.url': problem } : {}
  }
  if (kind === 'ntfy' || kind === 'gotify') {
    const r = (kind === 'ntfy' ? ntfyConfig : gotifyConfig).safeParse(config)
    if (!r.success) return { [`config.${String(r.error.issues[0]!.path[0] ?? 'url')}`]: r.error.issues[0]!.message }
    const problem = checkWebhookUrl('server' in r.data ? r.data.server : r.data.url)
    return problem ? { [kind === 'ntfy' ? 'config.server' : 'config.url']: problem } : {}
  }
  const r = teamsGraphConfig.safeParse(config)
  return r.success ? {} : { config: r.error.issues[0]!.message }
}

function targetSummary(kind: ChannelInput['kind'], config: unknown): string {
  if (kind === 'email') return emailConfig.parse(config).recipients.join(', ')
  if (kind === 'teams_webhook') return new URL(teamsWebhookConfig.parse(config).url).hostname
  if (kind === 'slack_webhook') return new URL(slackConfig.parse(config).url).hostname
  if (kind === 'discord_webhook') return new URL(discordConfig.parse(config).url).hostname
  if (kind === 'ntfy') { const n = ntfyConfig.parse(config); return `${new URL(n.server).hostname} / ${n.topic}` }
  if (kind === 'gotify') return new URL(gotifyConfig.parse(config).url).hostname
  const g = teamsGraphConfig.parse(config)
  return `équipe ${g.teamId.slice(0, 8)}…`
}

export async function storeChannelConfig(kind: ChannelInput['kind'], config: unknown, existingSecretId?: string): Promise<string> {
  const { envelope, keyId } = encryptSecret(JSON.stringify(config))
  if (existingSecretId) {
    await db().update(schema.secrets).set({ envelope, keyId }).where(eq(schema.secrets.id, existingSecretId))
    return existingSecretId
  }
  const [s] = await db().insert(schema.secrets).values({ purpose: `notification_${kind}`, envelope, keyId }).returning({ id: schema.secrets.id })
  return s!.id
}

export async function listChannels(): Promise<ChannelDto[]> {
  const rows = await db().select().from(schema.notificationChannels).orderBy(asc(schema.notificationChannels.name))
  const last = rows.length
    ? await db().selectDistinctOn([schema.notificationDeliveries.channelId], { channelId: schema.notificationDeliveries.channelId, status: schema.notificationDeliveries.status, at: schema.notificationDeliveries.createdAt, error: schema.notificationDeliveries.error })
      .from(schema.notificationDeliveries).where(inArray(schema.notificationDeliveries.channelId, rows.map(r => r.id)))
      .orderBy(schema.notificationDeliveries.channelId, desc(schema.notificationDeliveries.createdAt))
    : []
  const out: ChannelDto[] = []
  for (const c of rows) {
    let target = '—'
    try {
      target = targetSummary(c.kind, await channelConfig(c))
    }
    catch { /* configuration illisible : affichée comme telle */ }
    const l = last.find(x => x.channelId === c.id)
    out.push({
      id: c.id, kind: c.kind, name: c.name, target, events: c.events as NotificationEvent[], environmentIds: c.environmentIds, enabled: c.enabled, digest: c.digest as ChannelDto['digest'], digestHour: c.digestHour,
      lastDelivery: l ? { status: l.status, at: l.at.toISOString(), error: l.error } : null,
      createdAt: c.createdAt.toISOString(),
    })
  }
  return out
}

/** Envoi de test, synchrone, sans passer par la file. */
export async function testChannel(channelId: string, actor: string): Promise<void> {
  const [c] = await db().select().from(schema.notificationChannels).where(eq(schema.notificationChannels.id, channelId))
  if (!c) throw new NotificationError('Canal introuvable', false)
  await notificationAdapter(c.kind).send(await channelConfig(c), {
    event: 'deployment.succeeded',
    title: 'Notification de test',
    summary: `Message de test envoyé depuis la plateforme par ${actor}. Ce canal est correctement configuré.`,
    severity: 'info',
    facts: [{ label: 'Canal', value: c.name }, { label: 'Date', value: new Date().toLocaleString('fr-FR', { timeZone: 'Europe/Paris' }) }],
    link: `${env().APP_URL}/admin/notifications`,
  })
}

// ---------------------------------------------------------------------------
// Historique des envois
// ---------------------------------------------------------------------------

export interface DeliveryQuery extends TableQuery {
  status?: 'pending' | 'sent' | 'failed'
  event?: string
  channelId?: string
}

export async function listDeliveries(q: DeliveryQuery): Promise<Paginated<DeliveryDto>> {
  const d = schema.notificationDeliveries
  const e = schema.notificationEvents
  const where: SQL[] = []
  const { from, to } = periodRange(q)
  if (from) where.push(gte(d.createdAt, from))
  if (to) where.push(lte(d.createdAt, to))
  if (q.status) where.push(eq(d.status, q.status))
  if (q.event) where.push(eq(e.event, q.event))
  if (q.channelId) where.push(eq(d.channelId, q.channelId))
  if (q.q) where.push(or(ilike(e.title, `%${q.q}%`), ilike(d.channelName, `%${q.q}%`), ilike(d.error, `%${q.q}%`))!)
  const cond = where.length ? and(...where) : undefined
  const [sortKey, dir] = (q.sort ?? 'createdAt:desc').split(':') as [string, 'asc' | 'desc']
  const col = ({ createdAt: d.createdAt, status: d.status, channelName: d.channelName, event: e.event } as const)[sortKey as 'createdAt'] ?? d.createdAt
  const [rows, [{ total }]] = await Promise.all([
    db().select({ d, e: { event: e.event, title: e.title, severity: e.severity } }).from(d).innerJoin(e, eq(e.id, d.eventId)).where(cond)
      .orderBy(dir === 'asc' ? asc(col) : desc(col)).limit(q.pageSize).offset((q.page - 1) * q.pageSize),
    db().select({ total: count() }).from(d).innerJoin(e, eq(e.id, d.eventId)).where(cond),
  ]) as [{ d: typeof d.$inferSelect, e: { event: string, title: string, severity: string } }[], [{ total: number }]]
  return {
    items: rows.map(r => ({
      id: r.d.id, createdAt: r.d.createdAt.toISOString(), sentAt: r.d.sentAt?.toISOString() ?? null, event: r.e.event, title: r.e.title, severity: r.e.severity,
      channelName: r.d.channelName, kind: r.d.kind, status: r.d.status as DeliveryDto['status'], attempts: r.d.attempts, error: r.d.error,
    })),
    total, page: q.page, pageSize: q.pageSize,
  }
}


// ---------------------------------------------------------------------------
// Résumés périodiques
// ---------------------------------------------------------------------------

type Channel = typeof schema.notificationChannels.$inferSelect

/** Compose et met en file le résumé d'un canal pour [since, until] ; renvoie le nombre d'évènements résumés (0 : rien envoyé). */
async function sendDigest(c: Channel, since: Date, until: Date, memo?: NarrativeMemo): Promise<number> {
  const events = (await db().select().from(schema.notificationEvents).where(and(gte(schema.notificationEvents.createdAt, since), lte(schema.notificationEvents.createdAt, until))))
    .filter(e => e.event !== 'digest.summary' && c.events.includes(e.event) && (!e.environmentId || !c.environmentIds.length || c.environmentIds.includes(e.environmentId)))
  const kind = c.digest === 'weekly' ? 'weekly' : 'daily'
  const digest = composeDigest(events, kind, since, until)
  if (!digest) return 0
  // Synthèse facultative par Ollama (jamais bloquante) ; le récapitulatif habituel suit toujours.
  const narrative = await narrateDigest(events, kind, since, until, memo)
  const [ev] = await db().insert(schema.notificationEvents).values({ event: 'digest.summary', severity: digest.severity, title: digest.title, summary: withNarrative(digest.summary, narrative), facts: digest.facts, link: `${env().APP_URL}/admin/notifications` }).returning({ id: schema.notificationEvents.id })
  const [d] = await db().insert(schema.notificationDeliveries).values({ eventId: ev!.id, channelId: c.id, channelName: c.name, kind: c.kind }).returning({ id: schema.notificationDeliveries.id })
  await notificationQueue().add('deliver', { deliveryId: d!.id }, { attempts: DELIVERY_ATTEMPTS, backoff: { type: 'exponential', delay: 5_000 } })
  return events.length
}

/** Envoie le résumé des canaux en mode « résumé » dont l'échéance est passée (vérifié toutes les 15 minutes). */
export async function runDigests(now = new Date()): Promise<{ sent: number, empty: number }> {
  const channels = (await db().select().from(schema.notificationChannels).where(eq(schema.notificationChannels.enabled, true))).filter(c => c.digest !== 'off')
  let sent = 0
  let empty = 0
  const memo: NarrativeMemo = new Map()
  for (const c of channels) {
    const since = c.lastDigestAt ?? c.createdAt
    const boundary = digestDue(c, since, now)
    if (!boundary) continue
    // L'échéance est consommée d'abord : un incident d'envoi ne produit jamais deux résumés.
    await db().update(schema.notificationChannels).set({ lastDigestAt: boundary }).where(eq(schema.notificationChannels.id, c.id))
    if (await sendDigest(c, since, boundary, memo)) sent++
    else empty++
  }
  return { sent, empty }
}

/** Résumé immédiat d'un canal (aperçu ou rattrapage) : couvre les évènements depuis le dernier résumé. */
export async function digestNow(channelId: string): Promise<{ events: number }> {
  const [c] = await db().select().from(schema.notificationChannels).where(eq(schema.notificationChannels.id, channelId))
  if (!c) throw new NotificationError('Canal introuvable', false)
  if (c.digest === 'off') throw new NotificationError('Ce canal envoie chaque évènement aussitôt : activer un résumé quotidien ou hebdomadaire', false)
  const now = new Date()
  const events = await sendDigest(c, c.lastDigestAt ?? c.createdAt, now)
  if (events) await db().update(schema.notificationChannels).set({ lastDigestAt: now }).where(eq(schema.notificationChannels.id, channelId))
  return { events }
}
