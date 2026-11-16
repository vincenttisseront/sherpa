/**
 * Opérations en cours, affichées par UiActivityHost : libellé, étape courante
 * (publiée par le serveur), avancement, durée. Alimenté automatiquement par
 * le plugin 00.auth pour toute requête d'API suivie.
 */
export interface Activity {
  id: string
  label: string
  step: string | null
  current: number | null
  total: number | null
  done: string[]
  startedAt: number
  /** Visible seulement si l'attente dure (évite les clignotements). */
  visible: boolean
  status: 'running' | 'success' | 'error'
  /** Affichée dans la page elle-même (ex. panneau de déploiement) : pas de doublon en coin d'écran. */
  inline?: boolean
}

export function useActivity() {
  const items = useState<Activity[]>('activity', () => [])
  function start(id: string, label: string): Activity {
    const a: Activity = { id, label, step: null, current: null, total: null, done: [], startedAt: Date.now(), visible: false, status: 'running' }
    items.value = [...items.value, a]
    return a
  }
  function update(id: string, patch: Partial<Activity>) {
    items.value = items.value.map(a => (a.id === id ? { ...a, ...patch } : a))
  }
  function finish(id: string, status: 'success' | 'error') {
    const a = items.value.find(x => x.id === id)
    if (!a) return
    // Une opération jamais affichée disparaît sans bruit ; sinon on montre l'issue un instant.
    if (!a.visible) {
      items.value = items.value.filter(x => x.id !== id)
      return
    }
    update(id, { status })
    setTimeout(() => { items.value = items.value.filter(x => x.id !== id) }, status === 'success' ? 1200 : 3500)
  }
  return { items, start, update, finish }
}
