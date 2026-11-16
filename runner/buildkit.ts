/**
 * Progression d'un build BuildKit : le moteur la renvoie en messages `moby.buildkit.trace` dont
 * `aux` est un `StatusResponse` protobuf (base64). Décodage minimal (sommets, journaux) pour
 * produire des lignes de log lisibles, sans dépendance. Schéma : moby/buildkit api/services/control.
 */

type Value = number | Uint8Array
interface Field { no: number, value: Value }

function* fields(buf: Uint8Array): Generator<Field> {
  let pos = 0
  const varint = (): number => {
    let result = 0
    let shift = 0
    for (;;) {
      const b = buf[pos++]
      if (b === undefined) throw new Error('protobuf tronqué')
      result += (b & 0x7F) * 2 ** shift
      if (!(b & 0x80)) return result
      shift += 7
    }
  }
  while (pos < buf.length) {
    const tag = varint()
    const no = Math.floor(tag / 8)
    const wire = tag % 8
    if (wire === 0) yield { no, value: varint() }
    else if (wire === 2) {
      const len = varint()
      if (pos + len > buf.length) throw new Error('protobuf tronqué')
      yield { no, value: buf.subarray(pos, pos + len) }
      pos += len
    }
    else if (wire === 1) pos += 8
    else if (wire === 5) pos += 4
    else throw new Error(`type protobuf inconnu : ${wire}`)
  }
}

const text = (v: Value) => (typeof v === 'number' ? '' : new TextDecoder().decode(v))
/** google.protobuf.Timestamp → millisecondes. */
function timestamp(v: Value): number | null {
  if (typeof v === 'number') return null
  let s = 0
  let n = 0
  for (const f of fields(v)) {
    if (f.no === 1 && typeof f.value === 'number') s = f.value
    if (f.no === 2 && typeof f.value === 'number') n = f.value
  }
  return s * 1000 + Math.floor(n / 1e6)
}

export interface BuildVertex { digest: string, name: string, cached: boolean, started: number | null, completed: number | null, error: string }
export interface BuildLog { vertex: string, stream: number, msg: string }

export function decodeStatus(b64: string): { vertexes: BuildVertex[], logs: BuildLog[] } {
  const out = { vertexes: [] as BuildVertex[], logs: [] as BuildLog[] }
  for (const f of fields(Buffer.from(b64, 'base64'))) {
    if (typeof f.value === 'number') continue
    if (f.no === 1) {
      const v: BuildVertex = { digest: '', name: '', cached: false, started: null, completed: null, error: '' }
      for (const x of fields(f.value)) {
        if (x.no === 1) v.digest = text(x.value)
        else if (x.no === 3) v.name = text(x.value)
        else if (x.no === 4) v.cached = x.value === 1
        else if (x.no === 5) v.started = timestamp(x.value)
        else if (x.no === 6) v.completed = timestamp(x.value)
        else if (x.no === 7) v.error = text(x.value)
      }
      out.vertexes.push(v)
    }
    else if (f.no === 3) {
      const l: BuildLog = { vertex: '', stream: 1, msg: '' }
      for (const x of fields(f.value)) {
        if (x.no === 1) l.vertex = text(x.value)
        else if (x.no === 3 && typeof x.value === 'number') l.stream = x.value
        else if (x.no === 4) l.msg = text(x.value)
      }
      out.logs.push(l)
    }
  }
  return out
}

/**
 * Lignes de log d'un build BuildKit : étape commencée, terminée (durée) ou prise en cache, erreur,
 * et sortie des commandes. Les étapes internes (chargement du contexte, des métadonnées, export) sont omises.
 */
export class BuildTrace {
  private readonly steps = new Map<string, { name: string, started: boolean, done: boolean }>()
  /** Reste de ligne non terminée par sortie de commande (une ligne peut arriver en plusieurs morceaux). */
  private readonly partial = new Map<string, string>()

  constructor(private readonly emit: (line: string, stream: 'stdout' | 'stderr') => void) {}

  feed(b64: string): void {
    let status
    try {
      status = decodeStatus(b64)
    }
    catch {
      return
    }
    for (const v of status.vertexes) {
      const s = this.steps.get(v.digest) ?? { name: v.name, started: false, done: false }
      s.name = v.name || s.name
      this.steps.set(v.digest, s)
      const internal = s.name.startsWith('[internal]') || s.name.startsWith('exporting ') || s.name.startsWith('naming ') || s.name.startsWith('unpacking ') || s.name.startsWith('copy /context')
      if (v.started !== null && !s.started) {
        s.started = true
        if (!internal && !v.cached) this.emit(`▶ ${s.name}`, 'stdout')
      }
      if (v.completed !== null && !s.done) {
        s.done = true
        if (v.error) this.emit(`✗ ${s.name} : ${v.error}`, 'stderr')
        else if (!internal) this.emit(v.cached ? `✓ ${s.name} — en cache` : `✓ ${s.name} — terminé en ${v.started !== null ? Math.max(0, Math.round((v.completed - v.started) / 100) / 10) : '?'} s`, 'stdout')
      }
    }
    for (const l of status.logs) {
      const key = `${l.vertex}:${l.stream}`
      const lines = `${this.partial.get(key) ?? ''}${l.msg}`.split(/\r?\n/)
      this.partial.set(key, lines.pop() ?? '')
      for (const line of lines) if (line.trimEnd()) this.emit(line.trimEnd(), l.stream === 2 ? 'stderr' : 'stdout')
    }
  }

  /** Fin du build : dernières lignes non terminées. */
  flush(): void {
    for (const [key, rest] of this.partial) if (rest.trimEnd()) this.emit(rest.trimEnd(), key.endsWith(':2') ? 'stderr' : 'stdout')
    this.partial.clear()
  }
}

/** Échec qui justifie de refaire le build avec le builder classique (BuildKit ou son frontend indisponible), jamais une erreur de Dockerfile. */
export function buildkitUnavailable(message: string): boolean {
  if (/did not complete successfully|exit code: \d+/.test(message)) return false
  return /aucune progression|source metadata for \S*dockerfile|docker\/dockerfile|dockerfile frontend|frontend|buildkit.*(not|unsupported|disabled|unavailable)|(unknown|unsupported|invalid).*(builder|version)|unknown flag/i.test(message)
}
