/** Envoi HTTP commun aux canaux par service web (Slack, Discord, ntfy, Gotify) : hôte autorisé, HTTPS, sans redirection, délai borné. */
import { env } from '../../utils/env'
import { redactPatterns } from '../../utils/redact'
import { checkWebhookUrl } from './teams-webhook'
import { NotificationError } from './types'

export async function postJson(label: string, url: string, body: unknown, headers: Record<string, string> = {}): Promise<void> {
  const problem = checkWebhookUrl(url)
  if (problem) throw new NotificationError(problem, false)
  let res: Response
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify(body),
      redirect: 'manual',
      signal: AbortSignal.timeout(env().NOTIFY_TIMEOUT_MS),
    })
  }
  catch (err) {
    throw new NotificationError(`${label} injoignable : ${(err as Error).message}`)
  }
  if (res.status >= 300) {
    const text = redactPatterns((await res.text().catch(() => '')).slice(0, 300))
    // 4xx hors 429 : configuration refusée (URL, jeton), inutile de réessayer.
    throw new NotificationError(`${label} : réponse ${res.status}${text ? ` (${text})` : ''}`, res.status >= 500 || res.status === 429)
  }
}

export const trunc = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s)
export const SEVERITY_EMOJI = { info: 'ℹ️', warning: '⚠️', error: '🔴' } as const
