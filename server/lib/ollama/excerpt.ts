/**
 * Extrait de logs à envoyer au modèle : fonction pure (aucune E/S), testée.
 *
 * Un modèle local a une fenêtre de contexte réduite : on regroupe les lignes répétées, puis, si le
 * total dépasse le budget, on garde le début (démarrage, configuration lue), la fin (là où le
 * service s'est arrêté) et, entre les deux, les lignes qui ressemblent à une erreur. L'ordre
 * d'origine est conservé et chaque trou est signalé, pour que le modèle ne prenne pas un extrait
 * pour un journal continu.
 */
import { byNumber } from '../../../shared/utils/compare'

export interface Excerpt {
  text: string
  /** Lignes reçues. */
  totalLines: number
  /** Lignes présentes dans le texte (après regroupement des répétitions et bornage). */
  sentLines: number
  truncated: boolean
}

/** Une ligne plus longue est coupée : une trace ou un JSON sur une ligne ne doit pas épuiser le budget. */
export const MAX_LINE_CHARS = 600
const MARKER_RESERVE = 240

// Horodatage en tête de ligne (borné) : ignoré pour reconnaître deux lignes identiques.
const LEADING_TS = /^\S{0,40}\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:[.,]\d{1,9})?Z?\s*/
const ERRORISH = /\b(?:error|erreur|fatal|panic|exception|traceback|fail(?:ed|ure)?|denied|refused|timeout|timed out|oom|out of memory|killed|segfault|unhealthy|crash(?:ed)?)\b/i

const clip = (line: string): string => (line.length > MAX_LINE_CHARS ? `${line.slice(0, MAX_LINE_CHARS)}… [ligne coupée]` : line)

/** Lignes consécutives identiques (horodatage mis à part) regroupées en une seule, avec leur nombre. */
export function collapseRepeats(lines: readonly string[]): string[] {
  const out: string[] = []
  let key: string | null = null
  let first = ''
  let count = 0
  const flush = () => {
    if (count > 0) out.push(count > 1 ? `${first} [répétée ${count} fois]` : first)
  }
  for (const line of lines) {
    const k = line.replace(LEADING_TS, '')
    if (k === key) {
      count++
      continue
    }
    flush()
    key = k
    first = line
    count = 1
  }
  flush()
  return out
}

export function prepareExcerpt(rawLines: readonly string[], maxChars: number): Excerpt {
  const lines = collapseRepeats(rawLines.filter(l => l.trim()).map(clip))
  const size = (l: string) => l.length + 1
  const total = lines.reduce((n, l) => n + size(l), 0)
  if (total <= maxChars) {
    return { text: lines.join('\n'), totalLines: rawLines.length, sentLines: lines.length, truncated: false }
  }

  const budget = Math.max(0, maxChars - MARKER_RESERVE)
  const headBudget = Math.floor(budget * 0.15)
  const midBudget = Math.floor(budget * 0.25)
  const tailBudget = budget - headBudget - midBudget
  const keep = new Set<number>()

  let used = 0
  let head = 0
  while (head < lines.length && used + size(lines[head]!) <= headBudget) {
    keep.add(head)
    used += size(lines[head]!)
    head++
  }
  used = 0
  let tail = lines.length - 1
  while (tail >= head && used + size(lines[tail]!) <= tailBudget) {
    keep.add(tail)
    used += size(lines[tail]!)
    tail--
  }
  // Entre les deux : les lignes qui ressemblent à une erreur, les plus proches de la fin d'abord.
  used = 0
  for (let i = tail; i >= head; i--) {
    const line = lines[i]!
    if (ERRORISH.test(line) && used + size(line) <= midBudget) {
      keep.add(i)
      used += size(line)
    }
  }

  const out: string[] = []
  let previous = -1
  for (const i of [...keep].sort(byNumber)) {
    if (i - previous > 1) out.push(`[… ${i - previous - 1} ligne(s) omise(s) …]`)
    out.push(lines[i]!)
    previous = i
  }
  if (previous < lines.length - 1) out.push(`[… ${lines.length - 1 - previous} ligne(s) omise(s) …]`)
  return { text: out.join('\n'), totalLines: rawLines.length, sentLines: keep.size, truncated: true }
}
