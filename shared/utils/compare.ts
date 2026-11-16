/**
 * Comparateurs explicites pour `Array#sort()`.
 * Sans comparateur, `sort()` convertit les éléments en chaînes (un tri de nombres devient alphabétique) :
 * un comparateur nommé rend l'intention lisible et évite cette surprise.
 */

/** Ordre des unités de code UTF-16 : identique au tri par défaut sur des chaînes, donc déterministe (aucune dépendance à la locale). */
export const byCode = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0)

/** Ordre numérique croissant. */
export const byNumber = (a: number, b: number): number => a - b
