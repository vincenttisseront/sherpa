/** Gotify : message d'application (jeton dans l'en-tête, jamais dans l'URL), Markdown, priorité selon la gravité. */
import { gotifyConfig } from '../../../shared/schemas/notifications'
import { postJson, trunc } from './http-notify'
import type { NotificationAdapter, NotificationMessage } from './types'
import { trimTrailingSlashes } from '../../../shared/utils/trim'

const PRIORITY = { info: 3, warning: 5, error: 8 } as const

export function gotifyPayload(m: NotificationMessage) {
  return {
    title: trunc(m.title, 250),
    message: trunc([m.summary, '', ...m.facts.map(f => `- **${f.label}** : ${f.value}`)].join('\n'), 3500),
    priority: PRIORITY[m.severity],
    extras: {
      'client::display': { contentType: 'text/markdown' },
      ...(m.link ? { 'client::notification': { click: { url: m.link } } } : {}),
    },
  }
}

export const gotifyAdapter: NotificationAdapter = {
  kind: 'gotify',
  async send(config, message) {
    const c = gotifyConfig.parse(config)
    await postJson('Gotify', `${trimTrailingSlashes(c.url)}/message`, gotifyPayload(message), { 'x-gotify-key': c.token })
  },
}
