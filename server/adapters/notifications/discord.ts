/** Discord : webhook de salon, un « embed » coloré par gravité avec les faits en champs. */
import { discordConfig } from '../../../shared/schemas/notifications'
import { postJson, trunc } from './http-notify'
import type { NotificationAdapter, NotificationMessage } from './types'

const COLOR = { info: 0x3B82F6, warning: 0xF59E0B, error: 0xEF4444 } as const

export function discordPayload(m: NotificationMessage) {
  return {
    username: 'Sherpa',
    // Aucune mention (@everyone, rôles, personnes) ne doit sortir d'un texte de notification.
    allowed_mentions: { parse: [] as string[] },
    embeds: [{
      title: trunc(m.title, 256),
      description: trunc(m.summary, 4000),
      color: COLOR[m.severity],
      ...(m.link ? { url: m.link } : {}),
      fields: m.facts.slice(0, 25).map(f => ({ name: trunc(f.label, 256), value: trunc(f.value || '—', 1024), inline: true })),
      timestamp: new Date().toISOString(),
    }],
  }
}

export const discordAdapter: NotificationAdapter = {
  kind: 'discord_webhook',
  async send(config, message) {
    await postJson('Discord', discordConfig.parse(config).url, discordPayload(message))
  },
}
