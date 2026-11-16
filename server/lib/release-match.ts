/**
 * Fichier équivalent d'une release suivante : même code source (zip, tar.gz), ou fichier attaché
 * dont le nom, version retirée, est le même (« app-1.2.0-linux.tar.gz » → « app-1.3.0-linux.tar.gz »).
 */
export interface MatchableFile { key: string, name: string, kind: 'asset' | 'source', importable: boolean }

/** Nom sans version : tag de la release et numéros de version (v1.2.3, 1.2, 2026.10.1) retirés. */
export function versionlessName(name: string, tag: string): string {
  const t = tag.replace(/^v/i, '')
  let n = name.toLowerCase()
  if (t) n = n.split(tag.toLowerCase()).join('*').split(t.toLowerCase()).join('*')
  return n.replace(/v?\d+(?:\.\d+)+(?:[-+.]?(?:rc|beta|alpha|pre)[.\d]*)?/g, '*').replace(/\*+/g, '*')
}

export function matchingArchive<T extends MatchableFile>(previous: { key: string, name: string, tag: string }, files: readonly T[], tag: string): T | null {
  const importable = files.filter(f => f.importable)
  if (previous.key.startsWith('source:')) return importable.find(f => f.key === previous.key) ?? null
  const wanted = versionlessName(previous.name, previous.tag)
  return importable.find(f => f.kind === 'asset' && f.name === previous.name)
    ?? importable.find(f => f.kind === 'asset' && versionlessName(f.name, tag) === wanted)
    ?? null
}
