/** Extraction homogène des erreurs renvoyées par l'API (message + erreurs par champ des 422). */
export interface ApiErrorInfo {
  status: number | null
  message: string
  errors: Record<string, string>
}

export function apiError(err: unknown): ApiErrorInfo {
  const e = err as { statusCode?: number, data?: { statusMessage?: string, message?: string, data?: { errors?: Record<string, string> } } | string, message?: string }
  const data = typeof e.data === 'object' ? e.data : undefined
  // Passerelle sans réponse de l'application (redémarrage, proxy) : message lisible plutôt que « [POST] … 502 ».
  const unreachable = !data?.statusMessage && !data?.message && (e.statusCode === 502 || e.statusCode === 503 || e.statusCode === 504)
  return {
    status: e.statusCode ?? null,
    message: unreachable
      ? 'La plateforme ne répond pas (redémarrage en cours ?) : vérifier le résultat puis réessayer dans quelques secondes.'
      : data?.statusMessage ?? data?.message ?? e.message ?? 'Erreur inattendue',
    errors: data?.data?.errors ?? {},
  }
}

export function useEnvironments() {
  return useFetch<import('#shared/schemas/environments').EnvironmentDto[]>('/api/environments', { key: 'environments', default: () => [] })
}
