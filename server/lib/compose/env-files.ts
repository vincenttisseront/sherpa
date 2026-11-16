/**
 * Fichiers `env_file` d'un Compose : lecture (format dotenv de Docker Compose)
 * et correspondance clé → variable de la plateforme.
 *
 * Une clé présente dans plusieurs fichiers garde son nom pour le premier fichier
 * (ordre d'apparition dans le Compose) et reçoit un nom préfixé par le fichier
 * pour les suivants (ex. REDIS_PASSWORD de redis-cache.env → REDIS_CACHE_REDIS_PASSWORD) :
 * deux services ne partagent jamais par erreur une valeur différente. La
 * correspondance ne dépend que des noms : elle se recalcule sans les valeurs.
 */
import { posix } from 'node:path'

export interface DotenvEntry { key: string, value: string }

const KEY_RE = /^[A-Za-z_][A-Za-z0-9_.-]*$/
const VAR_RE = /^[A-Za-z_][A-Za-z0-9_]*$/

export function parseDotenv(text: string): DotenvEntry[] {
  const out = new Map<string, string>()
  for (const raw of text.replace(/\r\n?/g, '\n').split('\n')) {
    const line = raw.trim()
    if (!line || line.startsWith('#')) continue
    const m = /^(?:export\s+)?([^=\s]+)\s*=\s*(.*)$/.exec(line)
    if (!m || !KEY_RE.test(m[1]!)) continue
    let v = m[2]!
    if (v.startsWith('"')) {
      const end = v.indexOf('"', 1)
      v = (end > 0 ? v.slice(1, end) : v.slice(1)).replace(/\\n/g, '\n').replace(/\\"/g, '"')
    }
    else if (v.startsWith('\'')) {
      const end = v.indexOf('\'', 1)
      v = end > 0 ? v.slice(1, end) : v.slice(1)
    }
    else {
      v = v.replace(/\s+#.*$/, '').trim()
    }
    out.set(m[1]!, v)
  }
  return [...out.entries()].map(([key, value]) => ({ key, value }))
}

const sanitize = (s: string) => s.toUpperCase().replace(/[^A-Z0-9_]/g, '_').replace(/^(\d)/, '_$1')

/** Correspondance fichier → (clé → variable), pour des fichiers donnés dans l'ordre du Compose. */
export function envFileVarNames(files: readonly { path: string, keys: readonly string[] }[]): Map<string, Map<string, string>> {
  const owner = new Map<string, string>()
  const used = new Set<string>()
  const result = new Map<string, Map<string, string>>()
  for (const f of files) {
    if (result.has(f.path)) continue
    const map = new Map<string, string>()
    const base = sanitize(posix.basename(f.path).replace(/\.env$|\.[^.]+$/, '').replace(/^\./, '') || 'ENV')
    for (const key of f.keys) {
      const plain = VAR_RE.test(key) ? key : sanitize(key)
      let name = !owner.has(plain) || owner.get(plain) === f.path ? plain : `${base}_${plain}`
      if (!owner.has(plain)) owner.set(plain, f.path)
      if (used.has(name) && owner.get(plain) !== f.path) {
        let i = 2
        while (used.has(`${name}_${i}`)) i++
        name = `${name}_${i}`
      }
      used.add(name)
      map.set(key, name)
    }
    result.set(f.path, map)
  }
  return result
}

/** Nom évoquant un secret : importé comme variable secrète. */
export function looksSecret(name: string): boolean {
  return /PASS|SECRET|TOKEN|PEPPER|SALT|PRIVATE|CREDENTIAL|(^|_)KEY($|_)|API_?KEY|AUTH/i.test(name)
}

/** Fichiers env_file d'un service (chaîne, liste, ou forme longue { path, required }). */
export function envFileRefs(value: unknown): { path: string, required: boolean }[] {
  const items = Array.isArray(value) ? value : value === undefined || value === null ? [] : [value]
  return items.flatMap((i): { path: string, required: boolean }[] => {
    if (typeof i === 'string') return [{ path: i, required: true }]
    if (i && typeof i === 'object' && typeof (i as { path?: unknown }).path === 'string') return [{ path: (i as { path: string }).path, required: (i as { required?: unknown }).required !== false }]
    return []
  })
}
