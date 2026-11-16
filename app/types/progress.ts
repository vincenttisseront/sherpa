/** Étape affichée par UiProgressSteps. */
export interface ProgressStep {
  label: string
  state: 'pending' | 'active' | 'done' | 'error'
  detail?: string | null
  /** Temps passé dans l'étape (« 3 min 12 s »). */
  duration?: string | null
  /** Avancement de l'étape en cours (0-100) ; absent : indéterminé. */
  percent?: number | null
}
