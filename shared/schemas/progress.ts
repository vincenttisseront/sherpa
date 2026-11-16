/** Avancement d'une opération longue, publié par le serveur pendant la requête. */
export interface ProgressState {
  /** Étape en cours, en français (« Découverte des endpoints »). */
  label: string
  /** Avancement déterminé (étape n sur total), sinon indéterminé. */
  current: number | null
  total: number | null
  /** Étapes terminées, dans l'ordre. */
  done: string[]
  updatedAt: string
}

/** Identifiant d'avancement transmis par le client (en-tête x-progress-id). */
export const PROGRESS_ID_RE = /^[A-Za-z0-9-]{16,64}$/
