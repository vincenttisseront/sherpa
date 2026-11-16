/** Images affichables en aperçu (explorateur de fichiers) : type d'après l'extension. */
const TYPES: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  avif: 'image/avif',
  bmp: 'image/bmp',
  ico: 'image/x-icon',
  svg: 'image/svg+xml',
}

/** Taille maximale d'une image affichée en aperçu. */
export const MAX_PREVIEW_BYTES = 20 * 1024 * 1024

export function imageTypeOf(name: string): string | null {
  const ext = name.toLowerCase().split('/').pop()?.split('.').slice(1).pop() ?? ''
  return TYPES[ext] ?? null
}

/** Archives extractibles dans l'explorateur, et nom du dossier d'extraction (nom sans extension). */
const ARCHIVE_RE = /^(.+?)\.(zip|tar|tar\.gz|tgz|tar\.bz2|tbz2?|tar\.xz|txz)$/i

export function archiveOf(name: string): { kind: 'zip' | 'tar', folder: string } | null {
  const base = name.split('/').pop() ?? name
  const m = base.match(ARCHIVE_RE)
  if (!m) return null
  return { kind: m[2]!.toLowerCase() === 'zip' ? 'zip' : 'tar', folder: m[1]! }
}
