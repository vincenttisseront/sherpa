/** ntfy (ntfy.sh ou serveur auto-hébergé) : publication JSON (UTF-8), priorité selon la gravité, jeton facultatif. */
import { ntfyConfig } from '../../../shared/schemas/notifications'
import { postJson, trunc } from './http-notify'
import type { NotificationAdapter, NotificationMessage } from './types'

const PRIORITY = { info: 3, warning: 4, error: 5 } as const
const TAGS = { info: ['information_source'], warning: ['warning'], error: ['rotating_light'] } as const

export function ntfyPayload(topic: string, m: NotificationMessage) {
  return {
    topic,
    title: trunc(m.title, 250),
    message: trunc([m.summary, ...m.facts.map(f => `${f.label} : ${f.value}`)].join('\n'), 3500),
    priority: PRIORITY[m.severity],
    tags: TAGS[m.severity],
    ...(m.link ? { click: m.link } : {}),
  }
}

export const ntfyAdapter: NotificationAdapter = {
  kind: 'ntfy',
  async send(config, message) {
    const c = ntfyConfig.parse(config)
    await postJson('ntfy', c.server, ntfyPayload(c.topic, message), c.token ? { authorization: `Bearer ${c.token}` } : {})
  },
}
