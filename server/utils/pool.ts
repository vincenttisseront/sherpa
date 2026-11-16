/**
 * Exécute `fn` sur chaque élément avec au plus `limit` appels simultanés, résultats dans l'ordre.
 * À la première erreur, plus rien n'est lancé ; les appels en cours se terminent, puis cette erreur est relancée.
 */
export async function mapLimit<T, R>(items: readonly T[], limit: number, fn: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length)
  let next = 0
  let failure: { error: unknown } | null = null
  const worker = async () => {
    while (!failure && next < items.length) {
      const i = next++
      try {
        results[i] = await fn(items[i]!, i)
      }
      catch (error) {
        failure ??= { error }
      }
    }
  }
  await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, worker))
  if (failure) throw (failure as { error: unknown }).error
  return results
}
