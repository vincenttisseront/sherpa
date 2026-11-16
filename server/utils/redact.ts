/**
 * Masquage des secrets dans tout texte destiné aux logs, à l'audit ou à l'UI.
 * Deux mécanismes complémentaires :
 * - valeurs connues (tokens déchiffrés pendant un job) enregistrées dans un Redactor ;
 * - motifs génériques (Bearer, tokens GitHub/Portainer, password=...).
 */
const MASK = '••••••'

const PATTERNS: [RegExp, string][] = [
  [/\bgh[pousr]_[A-Za-z0-9]{20,}\b/g, MASK],
  [/\bgithub_pat_[A-Za-z0-9_]{20,}\b/g, MASK],
  [/\bptr_[A-Za-z0-9+/=_-]{16,}/g, MASK],
  [/(Bearer\s+)[A-Za-z0-9._~+/=-]{8,}/gi, `$1${MASK}`],
  [/((?:X-API-Key|Authorization)\s*[:=]\s*)\S+/gi, `$1${MASK}`],
  [/((?:password|passwd|pwd|secret|token|api[_-]?key|client[_-]?secret)\s*[=:]\s*)(?:"[^"]*"|'[^']*'|\S+)/gi, `$1${MASK}`],
  // Options de ligne de commande : --password valeur, --db-password=valeur, -p:valeur exclu (trop ambigu).
  // Préfixe de l'option borné à 64 caractères : sans borne, une ligne de journal faite de « - » coûtait un temps quadratique.
  [/(--?[\w-]{0,64}(?:password|passwd|secret|token|api[_-]?key|access[_-]?key)(?:=|\s+))(?!-)(?:"[^"]*"|'[^']*'|\S+)/gi, `$1${MASK}`],
  // Identifiants dans une URL de connexion (http, postgres, mysql, redis, amqp, mongodb…).
  [/(\b[a-z][a-z0-9+.-]*:\/\/)([^\s/:@]*):[^\s/@]+@/gi, `$1$2:${MASK}@`],
  [/(-----BEGIN [A-Z ]*PRIVATE KEY-----)[\s\S]*?(-----END [A-Z ]*PRIVATE KEY-----)/g, `$1${MASK}$2`],
  // Jeton des webhooks Watchtower (dans l'URL de notification, reprise par les journaux de Watchtower).
  [/(\/api\/watchtower\/(?:profile-)?hook\/[0-9a-f-]{36}\/)[A-Za-z0-9_-]{16,}/gi, `$1${MASK}`],
]

export function redactPatterns(input: string): string {
  return PATTERNS.reduce((out, [re, replacement]) => out.replace(re, replacement), input)
}

export class Redactor {
  private readonly values = new Set<string>()

  /** Enregistre une valeur sensible à masquer (ignorée si trop courte pour être distinctive). */
  add(value: string | null | undefined): this {
    if (value && value.length >= 6) this.values.add(value)
    return this
  }

  redact(input: string): string {
    let out = input
    // Les plus longues d'abord, pour qu'une valeur incluse dans une autre ne laisse pas de fragment.
    for (const v of [...this.values].sort((a, b) => b.length - a.length)) {
      out = out.split(v).join(MASK)
    }
    return redactPatterns(out)
  }
}

/** Masque récursivement les clés sensibles d'un objet (détails d'audit, payloads). */
export function redactObject<T>(value: T, redactor?: Redactor): T {
  const sensitiveKey = /pass|secret|token|api[-_]?key|authorization|cookie|private/i
  const walk = (v: unknown): unknown => {
    if (typeof v === 'string') return redactor ? redactor.redact(v) : redactPatterns(v)
    if (Array.isArray(v)) return v.map(walk)
    if (v && typeof v === 'object') {
      return Object.fromEntries(Object.entries(v).map(([k, val]) => [k, sensitiveKey.test(k) && val != null ? MASK : walk(val)]))
    }
    return v
  }
  return walk(value) as T
}
