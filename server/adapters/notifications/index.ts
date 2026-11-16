import { discordAdapter } from './discord'
import { emailAdapter } from './email'
import { gotifyAdapter } from './gotify'
import { ntfyAdapter } from './ntfy'
import { slackAdapter } from './slack'
import { teamsGraphAdapter } from './teams-graph'
import { teamsWebhookAdapter } from './teams-webhook'
import type { NotificationAdapter } from './types'

const ADAPTERS: Record<NotificationAdapter['kind'], NotificationAdapter> = {
  email: emailAdapter,
  teams_webhook: teamsWebhookAdapter,
  teams_graph: teamsGraphAdapter,
  slack_webhook: slackAdapter,
  discord_webhook: discordAdapter,
  ntfy: ntfyAdapter,
  gotify: gotifyAdapter,
}

export function notificationAdapter(kind: NotificationAdapter['kind']): NotificationAdapter {
  return ADAPTERS[kind]
}

export * from './types'
