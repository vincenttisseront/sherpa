/**
 * Avancement des opérations longues. Le client envoie un identifiant
 * (en-tête x-progress-id) avec sa requête, puis interroge /api/progress/:id
 * tant qu'elle est en cours ; le serveur y publie l'étape courante. Lié à
 * l'utilisateur de la session ; 10 minutes de rétention ; sans en-tête : aucun effet.
 */
import type { H3Event } from 'h3'
import { getHeader } from 'h3'
import { PROGRESS_ID_RE, type ProgressState } from '../../shared/schemas/progress'
import { redis } from '../queue/redis'

export interface Progress {
  /** Nouvelle étape ; current/total pour un avancement déterminé. */
  step(label: string, current?: number, total?: number): Promise<void>
}

export const noProgress: Progress = { step: async () => {} }

export function progressKey(userId: string | null, id: string): string {
  return `progress:${userId ?? 'anonyme'}:${id}`
}

export function requestProgress(event: H3Event): Progress {
  const id = getHeader(event, 'x-progress-id')
  if (!id || !PROGRESS_ID_RE.test(id)) return noProgress
  const key = progressKey(event.context.user?.id ?? null, id)
  const done: string[] = []
  let last: string | null = null
  return {
    async step(label, current, total) {
      if (last) done.push(last)
      last = label
      const state: ProgressState = { label, current: current ?? null, total: total ?? null, done: [...done], updatedAt: new Date().toISOString() }
      // Une erreur Redis ne doit jamais faire échouer l'opération elle-même.
      await redis().set(key, JSON.stringify(state), 'EX', 600).catch(() => {})
    },
  }
}
