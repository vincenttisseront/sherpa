/**
 * Fichiers env_file référencés par un Compose et présents dans les sources
 * (archive ou dépôt) : clés (pour l'analyse) et, à la demande, valeurs (pour
 * l'import en variables de la plateforme). Les valeurs ne sont jamais stockées
 * en clair ni renvoyées au client.
 */
import { posix } from 'node:path'
import YAML from 'yaml'
import { type DotenvEntry, envFileRefs, parseDotenv } from '../lib/compose/env-files'
import { validateRelativeEntry } from '../utils/path-guard'

export const MAX_ENV_FILE = 256 * 1024

export interface EnvFilesFound {
  /** Fichiers dans l'ordre d'apparition du Compose (chemin depuis la racine des sources). */
  order: string[]
  keys: Record<string, string[]>
  values: Record<string, DotenvEntry[]>
}

export function envFilePathsOf(composeText: string, composePath: string): string[] {
  let doc: unknown
  try {
    doc = YAML.parseDocument(composeText, { merge: true }).toJS({ maxAliasCount: 100 })
  }
  catch {
    return []
  }
  const services = (doc as { services?: Record<string, { env_file?: unknown }> } | null)?.services
  if (!services || typeof services !== 'object') return []
  const dir = posix.dirname(composePath) === '.' ? '' : posix.dirname(composePath)
  const out: string[] = []
  for (const svc of Object.values(services)) {
    for (const f of envFileRefs(svc?.env_file)) {
      try {
        const p = validateRelativeEntry(posix.join(dir, f.path))
        if (!out.includes(p)) out.push(p)
      }
      catch {
        // Chemin invalide : signalé par l'analyse.
      }
    }
  }
  return out
}

export async function collectEnvFiles(composeText: string, composePath: string, files: ReadonlySet<string>, read: (path: string) => Promise<string>): Promise<EnvFilesFound> {
  const order = envFilePathsOf(composeText, composePath).filter(p => files.has(p))
  const keys: Record<string, string[]> = {}
  const values: Record<string, DotenvEntry[]> = {}
  for (const p of order) {
    const entries = parseDotenv(await read(p))
    values[p] = entries
    keys[p] = entries.map(e => e.key)
  }
  return { order, keys, values }
}

export interface EnvImportResult {
  imported: { name: string, secret: boolean, file: string, regenerated: boolean }[]
  /** Variables déjà définies, conservées telles quelles. */
  kept: string[]
  files: string[]
}
