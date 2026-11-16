/** Résumé périodique des notifications : échéance (heure de Paris) et composition du message (fonctions pures). */
import { EVENT_LABEL, type NotificationEvent } from '../../shared/schemas/notifications'
import { localParts } from '../../shared/utils/deploy-windows'

export const DIGEST_TZ = 'Europe/Paris'
export interface DigestSettings { digest: string, digestHour: number }

/** Dernier instant planifié (≤ now) du résumé : tous les jours à `hour`, ou le lundi à `hour` ; null si « off ». */
export function lastScheduled(s: DigestSettings, now: Date): Date | null {
  if (s.digest !== 'daily' && s.digest !== 'weekly') return null
  const start = new Date(Math.floor(now.getTime() / 60_000) * 60_000)
  for (let i = 0; i <= 8 * 24 * 60; i++) {
    const t = new Date(start.getTime() - i * 60_000)
    const { day, minutes } = localParts(t, DIGEST_TZ)
    if (minutes === s.digestHour * 60 && (s.digest === 'daily' || day === 1)) return t
  }
  return null
}

/** Le résumé est dû si une échéance est passée depuis le dernier envoi (ou la création du canal). */
export function digestDue(s: DigestSettings, since: Date, now: Date): Date | null {
  const boundary = lastScheduled(s, now)
  return boundary && boundary.getTime() > since.getTime() ? boundary : null
}

export interface DigestEvent { event: string, severity: string, title: string, createdAt: Date }
const RANK: Record<string, number> = { info: 0, warning: 1, error: 2 }

/** Message récapitulatif ; null s'il n'y a rien à résumer. */
export function composeDigest(events: readonly DigestEvent[], kind: 'daily' | 'weekly', from: Date, to: Date) {
  if (!events.length) return null
  const severity = events.reduce<string>((m, e) => ((RANK[e.severity] ?? 0) > (RANK[m] ?? 0) ? e.severity : m), 'info') as 'info' | 'warning' | 'error'
  const byEvent = new Map<string, number>()
  for (const e of events) byEvent.set(e.event, (byEvent.get(e.event) ?? 0) + 1)
  const count = (sev: string) => events.filter(e => e.severity === sev).length
  const fmt = (d: Date) => d.toLocaleString('fr-FR', { timeZone: DIGEST_TZ, dateStyle: 'short', timeStyle: 'short' })
  const worst = [...events].sort((a, b) => (RANK[b.severity] ?? 0) - (RANK[a.severity] ?? 0) || b.createdAt.getTime() - a.createdAt.getTime()).slice(0, 8)
  return {
    severity,
    title: `Résumé ${kind === 'daily' ? 'quotidien' : 'hebdomadaire'} — ${events.length} évènement${events.length > 1 ? 's' : ''}`,
    summary: `Du ${fmt(from)} au ${fmt(to)} : ${count('error')} erreur(s), ${count('warning')} alerte(s), ${count('info')} information(s).\n${worst.map(e => `• ${e.title}`).join('\n')}${events.length > worst.length ? `\n… et ${events.length - worst.length} autre(s)` : ''}`,
    facts: [...byEvent.entries()].sort((a, b) => b[1] - a[1]).map(([e, n]) => ({ label: EVENT_LABEL[e as NotificationEvent] ?? e, value: String(n) })),
  }
}
