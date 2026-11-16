/**
 * Garde-fou système de fichiers du Runner. En plus des règles lexicales de
 * path-guard (préfixes système, `..`), il vérifie sur le disque :
 * - que le chemin est sous une racine déclarée localement ;
 * - qu'aucun composant existant du chemin n'est un lien symbolique
 *   (un lien posé dans une release ne doit pas permettre de sortir des racines) ;
 * - que la racine elle-même n'est jamais supprimée ni remplacée.
 */
import { posix } from 'node:path'
import { PathViolation, assertNotSensitive, isWithin, normalizeAbsolute } from '../server/utils/path-guard'
import { type HostFs, localFs } from './host-fs'

export class FsGuard {
  constructor(private readonly roots: readonly string[], private readonly fs: HostFs = localFs) {}

  rootOf(path: string): string | undefined {
    return this.roots.find(r => isWithin(path, r))
  }

  /** Valide un chemin et renvoie sa forme normalisée. */
  async resolve(input: string, opts: { allowRoot?: boolean } = {}): Promise<string> {
    const p = normalizeAbsolute(input)
    assertNotSensitive(p)
    const root = this.rootOf(p)
    if (!root) throw new PathViolation(p, 'hors des racines autorisées sur cet hôte')
    if (p === root && !opts.allowRoot) throw new PathViolation(p, 'opération interdite sur une racine')

    // Chaque composant existant, racine comprise, ne doit pas être un lien symbolique.
    const rel = posix.relative(root, p)
    const parts = rel ? rel.split('/') : []
    let current = root
    for (const part of [null, ...parts]) {
      if (part !== null) current = posix.join(current, part)
      try {
        const st = await this.fs.lstat(current)
        if (st.isSymbolicLink()) throw new PathViolation(current, 'lien symbolique refusé')
        if (current !== p && !st.isDirectory()) throw new PathViolation(current, 'composant intermédiaire qui n\'est pas un répertoire')
      }
      catch (e) {
        if (this.fs.isNotFound(e)) break
        throw e
      }
    }
    return p
  }
}
