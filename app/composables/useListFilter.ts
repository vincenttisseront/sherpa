/**
 * Filtre des tableaux locaux (listes courtes chargées en entier : endpoints,
 * réseaux, volumes, groupes) : texte + statut, combinables, avec réinitialisation.
 */
export function useListFilter<T>(source: () => readonly T[], text: (row: T) => string, statusOf?: (row: T) => string) {
  const q = ref('')
  const status = ref('')
  const filtered = computed(() => {
    const needle = q.value.trim().toLowerCase()
    return source().filter(r => (!needle || text(r).toLowerCase().includes(needle)) && (!status.value || statusOf?.(r) === status.value))
  })
  const active = computed(() => !!q.value.trim() || !!status.value)
  function reset() {
    q.value = ''
    status.value = ''
  }
  return { q, status, filtered, active, reset, total: computed(() => source().length) }
}
