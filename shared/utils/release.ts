/** Identifiant de release utilisé dans les chemins et les tags d'image : r-0007-1a2b3c. */
export function releaseSlug(number: number, id: string): string {
  return `r-${String(number).padStart(4, '0')}-${id.slice(0, 6)}`
}
