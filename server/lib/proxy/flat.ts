/**
 * Représentation commune des configurations Traefik : clés pointées en
 * minuscules (Traefik ignore la casse des options) → valeur scalaire ou liste.
 * Sources : fichier YAML/TOML, arguments `--a.b=c`, variables `TRAEFIK_A_B`,
 * labels Docker `traefik.a.b`.
 */
import { parse as parseYaml } from 'yaml'

export type Scalar = string | number | boolean
export type Flat = Map<string, Scalar | Scalar[]>

export function flatten(value: unknown, prefix = '', out: Flat = new Map()): Flat {
  if (Array.isArray(value)) {
    if (value.every(v => v === null || typeof v !== 'object')) out.set(prefix, value.filter(v => v !== null) as Scalar[])
    else value.forEach((v, i) => flatten(v, prefix ? `${prefix}.${i}` : String(i), out))
  }
  else if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
    // Section vide (`dashboard: {}` ou `[api]`) : vaut activation.
    if (!entries.length && prefix) out.set(prefix, true)
    for (const [k, v] of entries) flatten(v, prefix ? `${prefix}.${k.toLowerCase()}` : k.toLowerCase(), out)
  }
  else if (value === null) {
    if (prefix) out.set(prefix, true)
  }
  else if (prefix) {
    out.set(prefix, value as Scalar)
  }
  return out
}

export const str = (v: Scalar | Scalar[] | undefined): string | null => (v === undefined ? null : Array.isArray(v) ? v.join(',') : String(v))
export const bool = (v: Scalar | Scalar[] | undefined, dflt = false): boolean => (v === undefined ? dflt : Array.isArray(v) ? v.length > 0 : v === true || String(v).toLowerCase() === 'true')
export const list = (v: Scalar | Scalar[] | undefined): string[] => (v === undefined ? [] : (Array.isArray(v) ? v.map(String) : String(v).split(',')).map(s => s.trim()).filter(Boolean))

/** Noms des sous-clés directes : `children(f, 'entrypoints')` → ['web', 'websecure']. */
export function children(flat: Flat, prefix: string): string[] {
  const p = `${prefix}.`
  const names = new Set<string>()
  for (const k of flat.keys()) if (k.startsWith(p)) names.add(k.slice(p.length).split('.')[0]!)
  return [...names]
}

export function has(flat: Flat, prefix: string): boolean {
  if (flat.has(prefix)) return true
  const p = `${prefix}.`
  for (const k of flat.keys()) if (k.startsWith(p)) return true
  return false
}

/** Arguments de ligne de commande Traefik (`--a.b=c`, `--a.b` seul vaut true). */
export function flatFromArgs(args: readonly string[]): Flat {
  const out: Flat = new Map()
  for (const a of args) {
    const m = /^--?([A-Za-z0-9_.-]+)(?:=(.*))?$/s.exec(a)
    if (!m) continue
    out.set(m[1]!.toLowerCase(), m[2] === undefined ? true : m[2])
  }
  return out
}

/** Variables `TRAEFIK_ENTRYPOINTS_WEB_ADDRESS` → `entrypoints.web.address`. */
export function flatFromEnv(env: Record<string, string>): Flat {
  const out: Flat = new Map()
  for (const [k, v] of Object.entries(env)) {
    if (!/^TRAEFIK_/i.test(k)) continue
    out.set(k.slice(8).toLowerCase().replace(/_/g, '.'), v)
  }
  return out
}

/** Labels d'un conteneur sous un préfixe (`traefik.`), préfixe retiré. */
export function flatFromLabels(labels: Record<string, string>, prefix: string): Flat {
  const out: Flat = new Map()
  for (const [k, v] of Object.entries(labels)) {
    if (k.toLowerCase().startsWith(prefix)) out.set(k.slice(prefix.length).toLowerCase(), v)
  }
  return out
}

export class ConfigParseError extends Error {}

/** Fichier de configuration (YAML ou TOML d'après l'extension, YAML à défaut). */
export function parseConfigFile(path: string, text: string): unknown {
  if (/\.toml$/i.test(path)) return parseToml(text)
  try {
    return parseYaml(text, { maxAliasCount: 50 })
  }
  catch (err) {
    throw new ConfigParseError(`YAML invalide : ${(err as Error).message.split('\n')[0]}`)
  }
}

// ---------------------------------------------------------------------------
// TOML : sous-ensemble utilisé par les configurations Traefik (tables,
// tableaux de tables, clés pointées, chaînes, nombres, booléens, listes,
// tables en ligne). Les chaînes multilignes ne sont pas prises en charge.
// ---------------------------------------------------------------------------

type Obj = Record<string, unknown>

export function parseToml(text: string): Obj {
  const root: Obj = {}
  let current: Obj = root
  const src = text.replace(/\r\n?/g, '\n')
  let i = 0
  const fail = (msg: string): never => {
    const line = src.slice(0, i).split('\n').length
    throw new ConfigParseError(`TOML ligne ${line} : ${msg}`)
  }
  const ws = () => {
    while (i < src.length) {
      const c = src[i]!
      if (c === ' ' || c === '\t') i++
      else if (c === '#') while (i < src.length && src[i] !== '\n') i++
      else break
    }
  }
  const wsNl = () => {
    for (;;) {
      ws()
      if (src[i] === '\n') i++
      else break
    }
  }
  const parseString = (): string => {
    const q = src[i]!
    if (src.startsWith(q.repeat(3), i)) fail('chaîne multiligne non prise en charge')
    i++
    let s = ''
    while (i < src.length && src[i] !== q) {
      if (src[i] === '\n') fail('chaîne non terminée')
      if (q === '"' && src[i] === '\\') {
        const e = src[i + 1]
        const map: Record<string, string> = { 'n': '\n', 't': '\t', '"': '"', '\\': '\\', 'r': '\r' }
        if (e && e in map) {
          s += map[e]
          i += 2
          continue
        }
        if (e === 'u') {
          s += String.fromCharCode(Number.parseInt(src.slice(i + 2, i + 6), 16))
          i += 6
          continue
        }
        fail('échappement invalide')
      }
      s += src[i++]
    }
    if (src[i] !== q) fail('chaîne non terminée')
    i++
    return s
  }
  const parseKey = (): string[] => {
    const parts: string[] = []
    for (;;) {
      ws()
      if (src[i] === '"' || src[i] === '\'') parts.push(parseString())
      else {
        const m = /^[A-Za-z0-9_-]+/.exec(src.slice(i))
        if (!m) fail('clé attendue')
        parts.push(m![0])
        i += m![0].length
      }
      ws()
      if (src[i] === '.') i++
      else return parts
    }
  }
  const parseValue = (): unknown => {
    ws()
    const c = src[i]
    if (c === '"' || c === '\'') return parseString()
    if (c === '[') {
      i++
      const arr: unknown[] = []
      for (;;) {
        wsNl()
        if (src[i] === ']') {
          i++
          return arr
        }
        arr.push(parseValue())
        wsNl()
        if (src[i] === ',') i++
        else if (src[i] !== ']') fail('liste mal formée')
      }
    }
    if (c === '{') {
      i++
      const obj: Obj = {}
      ws()
      if (src[i] === '}') {
        i++
        return obj
      }
      for (;;) {
        const key = parseKey()
        ws()
        if (src[i] !== '=') fail('« = » attendu')
        i++
        setPath(obj, key, parseValue())
        ws()
        if (src[i] === ',') i++
        else if (src[i] === '}') {
          i++
          return obj
        }
        else fail('table en ligne mal formée')
      }
    }
    const m = /^[^\s,\]}#]+/.exec(src.slice(i))
    if (!m) fail('valeur attendue')
    i += m![0].length
    const raw = m![0]
    if (raw === 'true') return true
    if (raw === 'false') return false
    const n = Number(raw.replace(/_/g, ''))
    return Number.isFinite(n) ? n : raw
  }
  const setPath = (obj: Obj, key: string[], value: unknown) => {
    let o = obj
    for (const k of key.slice(0, -1)) {
      if (!o[k] || typeof o[k] !== 'object') o[k] = {}
      o = o[k] as Obj
    }
    o[key.at(-1)!] = value
  }
  const table = (key: string[], arrayOf: boolean): Obj => {
    let o = root
    key.forEach((k, idx) => {
      const last = idx === key.length - 1
      if (last && arrayOf) {
        if (!Array.isArray(o[k])) o[k] = []
        const t: Obj = {}
        ;(o[k] as Obj[]).push(t)
        o = t
        return
      }
      let next = o[k]
      if (Array.isArray(next)) next = next.at(-1)
      if (!next || typeof next !== 'object') {
        next = {}
        o[k] = next
      }
      o = next as Obj
    })
    return o
  }

  while (i < src.length) {
    wsNl()
    if (i >= src.length) break
    if (src[i] === '[') {
      const arrayOf = src[i + 1] === '['
      i += arrayOf ? 2 : 1
      const key = parseKey()
      if (src[i] !== ']' || (arrayOf && src[i + 1] !== ']')) fail('en-tête de table mal formé')
      i += arrayOf ? 2 : 1
      current = table(key, arrayOf)
    }
    else {
      const key = parseKey()
      ws()
      if (src[i] !== '=') fail('« = » attendu')
      i++
      setPath(current, key, parseValue())
    }
    ws()
    if (i < src.length && src[i] !== '\n') fail('fin de ligne attendue')
  }
  return root
}
