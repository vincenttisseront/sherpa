import { z } from 'zod'

/** Déploiement au `git push` : réglage d'une cible (projet × environnement). */
export const targetWebhookInput = z.object({
  enabled: z.boolean(),
  /** Branche suivie par cet environnement ; vide : celle de la source du projet (si elle suit une branche). */
  branch: z.string().trim().max(250).regex(/^[A-Za-z0-9._\-/]*$/, 'Nom de branche invalide').nullable().default(null).transform(v => v || null),
  cleanBuild: z.boolean().default(false),
})
export type TargetWebhookInput = z.infer<typeof targetWebhookInput>
export type TargetWebhook = TargetWebhookInput

export type WebhookOutcome = 'accepted' | 'ignored' | 'done' | 'error'
export interface WebhookTargetResult {
  targetId: string
  environment: string
  outcome: 'started' | 'up-to-date' | 'waiting' | 'skipped' | 'error'
  deploymentId?: string | null
  message?: string | null
}
export interface WebhookDeliveryDto {
  id: string
  guid: string
  event: string
  ref: string | null
  sha: string | null
  outcome: WebhookOutcome
  detail: string | null
  results: WebhookTargetResult[]
  createdAt: string
}

export interface WebhookTargetDto { targetId: string, environment: string, environmentName: string, isProduction: boolean, webhook: TargetWebhook | null, effectiveBranch: string | null }
export interface ProjectWebhookDto {
  /** Adresse à renseigner dans GitHub (Payload URL), même si le secret n'est pas encore généré. */
  url: string
  configured: boolean
  createdAt: string | null
  lastDeliveryAt: string | null
  /** Le projet suit un dépôt GitHub (sinon rien à déclencher). */
  github: { repository: string, refType: 'branch' | 'tag' | 'commit' | null, ref: string | null } | null
  /** Token du projet autorisé à publier le statut sur GitHub (« Deployments : write ») : inconnu tant qu'aucune publication n'a été tentée. */
  statusReporting: 'token' | 'no-token' | 'none'
  targets: WebhookTargetDto[]
  deliveries: WebhookDeliveryDto[]
}
