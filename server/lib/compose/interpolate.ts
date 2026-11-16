/**
 * Interpolation des variables Compose (${VAR}, ${VAR:-défaut}, ${VAR-défaut},
 * ${VAR:?erreur}, ${VAR?erreur}, $VAR, $$ pour un dollar littéral).
 *
 * Règle de la plateforme : les variables NON secrètes sont substituées dans
 * le Compose final ; les variables SECRÈTES restent des références ${VAR},
 * dont la valeur est transmise à Portainer à part (jamais écrite sur disque
 * ni en base en clair). Pour l'analyse, une référence secrète est remplacée
 * par un jeton repérable, ce qui permet de vérifier qu'elle n'apparaît que
 * dans des valeurs d'environnement.
 */
export interface Variable {
  value: string
  secret: boolean
  /** Services dont l'environnement reçoit la variable (« * » : tous), même si le Compose ne la cite pas. */
  inject?: string[]
}

export interface VariableUse {
  name: string
  hasDefault: boolean
  required: boolean
}

const NAME = '[A-Za-z_][A-Za-z0-9_]*'
// $$ | ${NAME[op default]} | $NAME
const TOKEN_RE = new RegExp(`\\$\\$|\\$\\{(${NAME})(?:(:?[-?])([^}]*))?\\}|\\$(${NAME})`, 'g')

export const SECRET_TOKEN_PREFIX = '__PLATFORM_SECRET_'
const SECRET_TOKEN_RE = new RegExp(`${SECRET_TOKEN_PREFIX}(${NAME})__`, 'g')

export function secretToken(name: string): string {
  return `${SECRET_TOKEN_PREFIX}${name}__`
}

/** Liste les variables référencées dans un texte Compose. */
export function findVariables(text: string): VariableUse[] {
  const uses = new Map<string, VariableUse>()
  for (const m of text.matchAll(TOKEN_RE)) {
    if (m[0] === '$$') continue
    const name = (m[1] ?? m[4])!
    const op = m[2]
    const hasDefault = op === '-' || op === ':-'
    const required = op === '?' || op === ':?'
    const prev = uses.get(name)
    uses.set(name, {
      name,
      // Une seule utilisation sans défaut suffit à rendre la variable nécessaire.
      hasDefault: prev ? prev.hasDefault && hasDefault : hasDefault,
      required: (prev?.required ?? false) || required,
    })
  }
  return [...uses.values()].sort((a, b) => a.name.localeCompare(b.name))
}

/**
 * Interpole UNE valeur scalaire (Compose interpole après l'analyse YAML, valeur
 * par valeur : aucune injection de structure possible). Les valeurs
 * substituées voient leurs `$` doublés : Compose ne les réinterprétera pas.
 */
export function interpolateValue(text: string, vars: Record<string, Variable>, missing: Set<string>): string {
  return text.replace(TOKEN_RE, (whole, braced: string | undefined, op: string | undefined, arg: string | undefined, bare: string | undefined) => {
    if (whole === '$$') return '$$'
    const name = (braced ?? bare)!
    const v = vars[name]
    if (v?.secret) return secretToken(name)
    const set = v !== undefined
    const empty = !set || v.value === ''
    const lit = (x: string) => x.replaceAll('$', '$$$$')
    switch (op) {
      case ':-': return empty ? (arg ?? '') : lit(v!.value)
      case '-': return set ? lit(v.value) : (arg ?? '')
      case ':?':
      case '?':
        if ((op === ':?' && empty) || (op === '?' && !set)) missing.add(name)
        return lit(v?.value ?? '')
      default:
        if (!set) missing.add(name)
        return lit(v?.value ?? '')
    }
  })
}

/** Interpole récursivement toutes les valeurs (pas les clés) d'un document. */
export function interpolateTree<T>(node: T, vars: Record<string, Variable>, missing: Set<string>): T {
  if (typeof node === 'string') return interpolateValue(node, vars, missing) as T
  if (Array.isArray(node)) return node.map(n => interpolateTree(n, vars, missing)) as T
  if (node && typeof node === 'object') {
    return Object.fromEntries(Object.entries(node).map(([k, v]) => [k, interpolateTree(v, vars, missing)])) as T
  }
  return node
}

/** Valeur effective pour l'analyse : `$$` → `$`, jetons secrets conservés. */
export function unescapeDollars(text: string): string {
  return text.replaceAll('$$', '$')
}

/** Remet les références ${VAR} à la place des jetons secrets (texte final). */
export function restoreSecretRefs(text: string): string {
  return text.replace(SECRET_TOKEN_RE, (_m, name: string) => `\${${name}}`)
}

export function containsSecretToken(value: unknown): boolean {
  return typeof value === 'string' && value.includes(SECRET_TOKEN_PREFIX)
}
