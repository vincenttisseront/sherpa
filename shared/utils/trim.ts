/**
 * Retrait de caractères en bordure de chaîne, en temps linéaire.
 * Remplace les `.replace(/\/+$/, '')` : une expression régulière « x+$ » se réévalue depuis chaque
 * occurrence de « x » et devient quadratique sur une longue suite de caractères non terminale.
 */

/** Retire les occurrences de `ch` (un caractère) à la fin de `s`. */
export function trimEndChars(s: string, ch: string): string {
  let end = s.length
  while (end > 0 && s[end - 1] === ch) end--
  return end === s.length ? s : s.slice(0, end)
}

/** Retire les occurrences de `ch` (un caractère) au début et à la fin de `s`. */
export function trimChars(s: string, ch: string): string {
  let start = 0
  let end = s.length
  while (start < end && s[start] === ch) start++
  while (end > start && s[end - 1] === ch) end--
  return start === 0 && end === s.length ? s : s.slice(start, end)
}

/** Retire les « / » de fin. */
export const trimTrailingSlashes = (s: string): string => trimEndChars(s, '/')
