/** Canaux de notification (§18) : email, webhook Teams, Microsoft Graph (abstraction prévue). */
import { z } from 'zod'

export const NOTIFICATION_EVENTS = [
  'deployment.succeeded',
  'build.failed',
  'deployment.failed',
  'server.unavailable',
  'healthcheck.degraded',
  'deployment.rolled_back',
  'watchtower.error',
  'user.invited',
  'permissions.changed',
  'rebuild.auto',
  'github.alert',
  'vulnerability.found',
  'resource.alert',
  'deployment.approval',
  /** Résumé périodique : émis par la plateforme pour les canaux en mode « résumé », jamais choisi par un canal. */
  'digest.summary',
] as const
export type NotificationEvent = (typeof NOTIFICATION_EVENTS)[number]

export const EVENT_LABEL: Record<NotificationEvent, string> = {
  'deployment.succeeded': 'Déploiement réussi',
  'build.failed': 'Échec de build',
  'deployment.failed': 'Échec de déploiement',
  'server.unavailable': 'Agent indisponible',
  'healthcheck.degraded': 'Healthcheck dégradé',
  'deployment.rolled_back': 'Rollback',
  'watchtower.error': 'Erreur Watchtower',
  'user.invited': 'Invitation utilisateur',
  'permissions.changed': 'Changement de permissions',
  'rebuild.auto': 'Reconstruction automatique',
  'github.alert': 'Alerte GitHub (packages, artefacts)',
  'vulnerability.found': 'Vulnérabilités (Trivy)',
  'resource.alert': 'Alerte de ressources (CPU, mémoire, redémarrages)',
  'deployment.approval': 'Déploiement à valider (ou validé, refusé)',
  'digest.summary': 'Résumé périodique',
}
/** Évènements qu'un canal peut choisir (le résumé périodique se règle par le mode du canal). */
export const SELECTABLE_EVENTS = NOTIFICATION_EVENTS.filter(e => e !== 'digest.summary') as Exclude<NotificationEvent, 'digest.summary'>[]

export const CHANNEL_KINDS = ['email', 'teams_webhook', 'teams_graph', 'slack_webhook', 'discord_webhook', 'ntfy', 'gotify'] as const
export type ChannelKind = (typeof CHANNEL_KINDS)[number]
export const KIND_LABEL: Record<ChannelKind, string> = { email: 'Email', teams_webhook: 'Teams (webhook)', teams_graph: 'Teams (Microsoft Graph)', slack_webhook: 'Slack (webhook)', discord_webhook: 'Discord (webhook)', ntfy: 'ntfy', gotify: 'Gotify' }

export const emailConfig = z.object({ recipients: z.array(z.email('Adresse email invalide').max(254)).min(1, 'Au moins un destinataire').max(50) })
export const teamsWebhookConfig = z.object({ url: z.url('URL invalide').max(2048) })
export const slackConfig = z.object({ url: z.url('URL invalide').max(2048) })
export const discordConfig = z.object({ url: z.url('URL invalide').max(2048) })
export const ntfyConfig = z.object({
  server: z.url('URL invalide').max(500),
  topic: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/, 'Sujet : lettres, chiffres, _ et -'),
  token: z.string().max(500).optional(),
})
export const gotifyConfig = z.object({ url: z.url('URL invalide').max(500), token: z.string().min(1, 'Jeton de l\'application requis').max(500) })
export const teamsGraphConfig = z.object({
  tenantId: z.uuid(),
  clientId: z.uuid(),
  clientSecret: z.string().min(1).max(500),
  teamId: z.string().min(1).max(200),
  channelId: z.string().min(1).max(300),
})

export const channelInput = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('email'), config: emailConfig }),
  z.object({ kind: z.literal('teams_webhook'), config: teamsWebhookConfig }),
  z.object({ kind: z.literal('teams_graph'), config: teamsGraphConfig }),
  z.object({ kind: z.literal('slack_webhook'), config: slackConfig }),
  z.object({ kind: z.literal('discord_webhook'), config: discordConfig }),
  z.object({ kind: z.literal('ntfy'), config: ntfyConfig }),
  z.object({ kind: z.literal('gotify'), config: gotifyConfig }),
]).and(z.object({
  name: z.string().trim().min(2).max(100),
  events: z.array(z.enum(NOTIFICATION_EVENTS)).min(1, 'Choisir au moins un évènement'),
  /** off : chaque évènement part aussitôt ; daily / weekly : un seul message récapitulatif (lundi pour weekly), à l'heure de Paris. */
  digest: z.enum(['off', 'daily', 'weekly']).default('off'),
  digestHour: z.number().int().min(0).max(23).default(8),
  environmentIds: z.array(z.uuid()).max(50).default([]),
  enabled: z.boolean().default(true),
}))
export type ChannelInput = z.infer<typeof channelInput>

/** Mise à jour : la configuration (secrète) n'est renvoyée que pour être remplacée. */
export const channelPatch = z.object({
  name: z.string().trim().min(2).max(100).optional(),
  events: z.array(z.enum(NOTIFICATION_EVENTS)).min(1).optional(),
  environmentIds: z.array(z.uuid()).max(50).optional(),
  enabled: z.boolean().optional(),
  digest: z.enum(['off', 'daily', 'weekly']).optional(),
  digestHour: z.number().int().min(0).max(23).optional(),
  config: z.unknown().optional(),
})

export interface ChannelDto {
  id: string
  kind: ChannelKind
  name: string
  /** Résumé non secret : destinataires, ou hôte du webhook. */
  target: string
  events: NotificationEvent[]
  environmentIds: string[]
  enabled: boolean
  digest: 'off' | 'daily' | 'weekly'
  digestHour: number
  lastDelivery: { status: string, at: string, error: string | null } | null
  createdAt: string
}

export interface DeliveryDto {
  id: string
  createdAt: string
  sentAt: string | null
  event: string
  title: string
  severity: string
  channelName: string
  kind: ChannelKind
  status: 'pending' | 'sent' | 'failed'
  attempts: number
  error: string | null
}
