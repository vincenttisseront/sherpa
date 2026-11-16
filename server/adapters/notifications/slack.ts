/** Slack : webhook entrant (hooks.slack.com), blocs « header », texte et champs, bouton vers la plateforme. */
import { slackConfig } from '../../../shared/schemas/notifications'
import { SEVERITY_EMOJI, postJson, trunc } from './http-notify'
import type { NotificationAdapter, NotificationMessage } from './types'

/** mrkdwn : seuls &, < et > sont à échapper. */
const esc = (s: string) => s.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')

export function slackPayload(m: NotificationMessage) {
  const title = `${SEVERITY_EMOJI[m.severity]} ${m.title}`
  return {
    text: trunc(title, 300),
    blocks: [
      { type: 'header', text: { type: 'plain_text', text: trunc(title, 150), emoji: true } },
      { type: 'section', text: { type: 'mrkdwn', text: trunc(esc(m.summary), 2900) } },
      ...(m.facts.length ? [{ type: 'section', fields: m.facts.slice(0, 10).map(f => ({ type: 'mrkdwn', text: trunc(`*${esc(f.label)}*\n${esc(f.value)}`, 1900) })) }] : []),
      ...(m.link ? [{ type: 'actions', elements: [{ type: 'button', text: { type: 'plain_text', text: 'Ouvrir dans Sherpa' }, url: m.link }] }] : []),
    ],
  }
}

export const slackAdapter: NotificationAdapter = {
  kind: 'slack_webhook',
  async send(config, message) {
    await postJson('Slack', slackConfig.parse(config).url, slackPayload(message))
  },
}
