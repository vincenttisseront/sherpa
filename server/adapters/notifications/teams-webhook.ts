/**
 * Teams par webhook (Workflows / Power Automate ou connecteur entrant) : carte adaptative.
 * L'URL est un secret ; seuls les hôtes autorisés sont joignables, sans suivre de redirection.
 */
import { teamsWebhookConfig } from '../../../shared/schemas/notifications'
import { env } from '../../utils/env'
import { redactPatterns } from '../../utils/redact'
import { type NotificationAdapter, type NotificationMessage, NotificationError } from './types'

export function hostAllowed(host: string, patterns: string[]): boolean {
  const h = host.toLowerCase()
  return patterns.some((p) => {
    const x = p.trim().toLowerCase()
    if (!x) return false
    return x.startsWith('*.') ? h.endsWith(x.slice(1)) && h.length > x.length - 1 : h === x
  })
}

/** Contrôle de l'URL (enregistrement et envoi). Renvoie un message d'erreur ou null. */
export function checkWebhookUrl(raw: string): string | null {
  let u: URL
  try {
    u = new URL(raw)
  }
  catch {
    return 'URL invalide'
  }
  const e = env()
  if (u.protocol !== 'https:' && !(u.protocol === 'http:' && e.NODE_ENV !== 'production')) return 'HTTPS obligatoire'
  if (u.username || u.password) return 'Identifiants interdits dans l\'URL'
  if (!hostAllowed(u.hostname, e.NOTIFY_WEBHOOK_ALLOWED_HOSTS.split(','))) return `Hôte non autorisé (${u.hostname}) : voir NOTIFY_WEBHOOK_ALLOWED_HOSTS`
  return null
}

const COLOR = { info: 'accent', warning: 'warning', error: 'attention' } as const

export function adaptiveCard(m: NotificationMessage) {
  return {
    type: 'message',
    attachments: [{
      contentType: 'application/vnd.microsoft.card.adaptive',
      content: {
        $schema: 'http://adaptivecards.io/schemas/adaptive-card.json',
        type: 'AdaptiveCard',
        version: '1.4',
        msteams: { width: 'Full' },
        body: [
          { type: 'TextBlock', text: m.title, weight: 'Bolder', size: 'Medium', color: COLOR[m.severity], wrap: true },
          { type: 'TextBlock', text: m.summary, wrap: true },
          ...(m.facts.length ? [{ type: 'FactSet', facts: m.facts.map(f => ({ title: f.label, value: f.value })) }] : []),
        ],
        actions: m.link ? [{ type: 'Action.OpenUrl', title: 'Ouvrir dans la plateforme', url: m.link }] : [],
      },
    }],
  }
}

export const teamsWebhookAdapter: NotificationAdapter = {
  kind: 'teams_webhook',
  async send(config, message) {
    const { url } = teamsWebhookConfig.parse(config)
    const problem = checkWebhookUrl(url)
    if (problem) throw new NotificationError(problem, false)
    let res: Response
    try {
      res = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(adaptiveCard(message)),
        redirect: 'manual',
        signal: AbortSignal.timeout(env().NOTIFY_TIMEOUT_MS),
      })
    }
    catch (err) {
      throw new NotificationError(`Webhook Teams injoignable : ${(err as Error).message}`)
    }
    if (res.status >= 300) {
      const body = redactPatterns((await res.text().catch(() => '')).slice(0, 300))
      throw new NotificationError(`Webhook Teams : réponse ${res.status}${body ? ` (${body})` : ''}`, res.status >= 500 || res.status === 429)
    }
  },
}
