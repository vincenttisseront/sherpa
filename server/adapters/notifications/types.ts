/**
 * Notifications (§18). Le moteur émet des évènements typés ; chaque canal
 * (email, webhook Teams, Microsoft Graph) est un adaptateur interchangeable.
 * Ajouter Graph ne touche ni au moteur ni au dispatcher.
 */
import type { ChannelKind, NotificationEvent } from '../../../shared/schemas/notifications'

export { NOTIFICATION_EVENTS, type NotificationEvent } from '../../../shared/schemas/notifications'

export interface NotificationMessage {
  event: NotificationEvent
  title: string
  /** Texte brut, déjà masqué (redact). */
  summary: string
  severity: 'info' | 'warning' | 'error'
  facts: { label: string, value: string }[]
  link?: string | null
}

export interface NotificationAdapter {
  readonly kind: ChannelKind
  send(config: unknown, message: NotificationMessage): Promise<void>
}

export class NotificationError extends Error {
  constructor(message: string, public readonly retryable = true) {
    super(message)
    this.name = 'NotificationError'
  }
}
