/**
 * Synthèse en prose du résumé périodique des notifications, rédigée par Ollama. Elle précède le
 * récapitulatif habituel (décomptes, évènements les plus graves) et n'en remplace rien : le modèle ne
 * reçoit que les titres d'évènements déjà destinés aux canaux (masqués), jamais de log ni de détail.
 * Aucune erreur ne remonte : sans modèle disponible, le résumé part tel quel.
 */
import { EVENT_LABEL, type NotificationEvent } from '../../shared/schemas/notifications'
import { DIGEST_TZ } from '../lib/digest'
import { type DigestEventLine, digestNarrative, digestParts } from '../lib/ollama/contexts'
import { ollamaStatus } from './ollama'
import { runAiReport } from './ai-task'

const label = (event: string): string => EVENT_LABEL[event as NotificationEvent] ?? event
const fmt = (d: Date): string => d.toLocaleString('fr-FR', { timeZone: DIGEST_TZ, dateStyle: 'short', timeStyle: 'short' })

/** Résumés déjà rédigés pendant un passage (mêmes évènements sur plusieurs canaux : un seul appel au modèle). */
export type NarrativeMemo = Map<string, Promise<string | null>>

export async function narrateDigest(events: readonly (DigestEventLine & { id?: string })[], kind: 'daily' | 'weekly', from: Date, to: Date, memo?: NarrativeMemo): Promise<string | null> {
  if (!events.length) return null
  try {
    const status = await ollamaStatus()
    if (!status.enabled || !status.features.includes('digest')) return null
    const key = `${kind}|${from.getTime()}|${to.getTime()}|${events.map(e => e.id ?? `${e.event}:${e.title}:${e.createdAt.getTime()}`).sort().join(',')}`
    const known = memo?.get(key)
    if (known) return await known
    const run = (async () => {
      const { header, parts } = digestParts(events, label)
      const report = await runAiReport({
        feature: 'digest',
        header: [`Résumé ${kind === 'daily' ? 'quotidien' : 'hebdomadaire'}, du ${fmt(from)} au ${fmt(to)} (heure de Paris)`, ...header],
        parts,
      })
      return digestNarrative(report) || null
    })().catch((err: unknown) => {
      console.warn(`[notifications] synthèse du résumé par Ollama impossible : ${(err as { statusMessage?: string }).statusMessage ?? (err as Error).message}`)
      return null
    })
    memo?.set(key, run)
    return await run
  }
  catch (err) {
    console.warn(`[notifications] synthèse du résumé par Ollama impossible : ${(err as Error).message}`)
    return null
  }
}
