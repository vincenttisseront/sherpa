import type { OllamaFeature, OllamaStatusDto } from '#shared/schemas/ollama'

/** État de l'assistance par Ollama et disponibilité d'une fonction (connecteur actif et fonction cochée). */
export function useOllamaFeature(feature: OllamaFeature) {
  const { data: status } = useFetch<OllamaStatusDto>('/api/ollama/status', { key: 'ollama-status', default: () => ({ enabled: false, model: null, features: [] }) })
  const available = computed(() => !!status.value?.enabled && status.value.features.includes(feature))
  return { status, available }
}
