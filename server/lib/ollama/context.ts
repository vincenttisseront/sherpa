/**
 * Répartition du budget de contexte entre plusieurs blocs de données (fonction pure, testée).
 *
 * Une fonction d'assistance donne au modèle plusieurs blocs (diagnostic, conteneurs, logs…). Chacun a
 * un poids : un bloc qui tient dans sa part garde tout, ce qu'il n'utilise pas profite aux autres, et
 * un bloc trop long est borné par `prepareExcerpt` (début, fin, lignes d'erreur).
 */
import { type Excerpt, prepareExcerpt } from './excerpt'

export interface ContextPart {
  title: string
  lines: readonly string[]
  /** Part relative du budget (1 par défaut). */
  weight?: number
}

export interface PackedPart {
  title: string
  excerpt: Excerpt
}

export interface PackedContext {
  parts: PackedPart[]
  totalLines: number
  sentLines: number
  truncated: boolean
}

/** Balises et en-têtes de chaque bloc dans la consigne. */
export const PART_OVERHEAD = 120
const MIN_PART_CHARS = 300

export function packContext(input: readonly ContextPart[], maxChars: number): PackedContext {
  const parts = input.filter(p => p.lines.some(l => l.trim()))
  const full = parts.map(p => prepareExcerpt(p.lines, Number.POSITIVE_INFINITY))
  const weight = (i: number) => Math.max(0.1, parts[i]!.weight ?? 1)

  // Remplissage par paliers : les blocs qui tiennent dans leur part sont servis en entier, le reste du budget est redistribué.
  const alloc = parts.map(() => 0)
  let remaining = Math.max(0, maxChars - parts.length * PART_OVERHEAD)
  let open = parts.map((_, i) => i)
  while (open.length) {
    const sum = open.reduce((n, i) => n + weight(i), 0)
    const fits = open.filter(i => full[i]!.text.length <= remaining * weight(i) / sum)
    if (!fits.length) {
      for (const i of open) alloc[i] = Math.max(MIN_PART_CHARS, Math.floor(remaining * weight(i) / sum))
      break
    }
    for (const i of fits) {
      alloc[i] = full[i]!.text.length
      remaining -= alloc[i]!
    }
    open = open.filter(i => !fits.includes(i))
  }

  const packed = parts.map((p, i) => ({
    title: p.title,
    excerpt: full[i]!.text.length <= alloc[i]! ? full[i]! : prepareExcerpt(p.lines, alloc[i]!),
  }))
  return {
    parts: packed,
    totalLines: packed.reduce((n, p) => n + p.excerpt.totalLines, 0),
    sentLines: packed.reduce((n, p) => n + p.excerpt.sentLines, 0),
    truncated: packed.some(p => p.excerpt.truncated),
  }
}

/** Découpe un rapport texte en blocs d'après ses titres « === Titre ==== » (rapport tech support). */
export function splitReportSections(report: string): { title: string, lines: string[] }[] {
  const out: { title: string, lines: string[] }[] = []
  let current: { title: string, lines: string[] } | null = null
  for (const line of report.split('\n')) {
    const m = /^=== (.{1,200}?) ={3,}$/.exec(line)
    if (m) {
      current = { title: m[1]!, lines: [] }
      out.push(current)
    }
    else if (current) current.lines.push(line)
    else if (line.trim()) {
      current = { title: 'En-tête', lines: [line] }
      out.push(current)
    }
  }
  return out
}
