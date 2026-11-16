/**
 * Client HTTP d'Ollama (API native : /api/version, /api/tags, /api/chat).
 *
 * - Adresse revérifiée avant chaque appel (`checkOllamaUrl`), redirections refusées.
 * - Délai par appel porté par la connexion ; réponse bornée en taille.
 * - Les messages d'erreur ne contiennent ni le jeton ni l'adresse du serveur.
 * - Le navigateur n'appelle jamais Ollama : tout passe par ce client, côté serveur.
 */
import { checkOllamaUrl } from '../../lib/ollama/url'
import { redactPatterns } from '../../utils/redact'
import { type OllamaAdapter, type OllamaChatRequest, type OllamaChatResponse, type OllamaConnection, OllamaError, type OllamaModel } from './types'

const MAX_RESPONSE_BYTES = 4 * 1024 * 1024
const VERSION_TIMEOUT_MS = 10_000

function classify(err: unknown): OllamaError {
  if (err instanceof OllamaError) return err
  const e = err as { name?: string, code?: string, cause?: { code?: string } }
  if (e.name === 'TimeoutError' || e.name === 'AbortError') return new OllamaError('Délai dépassé : le modèle n\'a pas répondu à temps', 'timeout')
  const code = e.cause?.code ?? e.code ?? ''
  const reason = code === 'ECONNREFUSED' ? 'connexion refusée' : code === 'ENOTFOUND' ? 'nom d\'hôte inconnu' : code ? `erreur réseau ${code}` : 'erreur réseau'
  return new OllamaError(`Ollama injoignable (${reason})`, 'unreachable')
}

async function call(conn: OllamaConnection, method: 'GET' | 'POST', path: string, body?: unknown, timeoutMs = conn.timeoutMs): Promise<unknown> {
  const problem = checkOllamaUrl(conn.baseUrl)
  if (problem) throw new OllamaError(problem, 'invalid-url')
  let res: Response
  try {
    res = await fetch(`${conn.baseUrl}${path}`, {
      method,
      headers: {
        accept: 'application/json',
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        ...(conn.token ? { authorization: `Bearer ${conn.token}` } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      redirect: 'manual',
      signal: AbortSignal.timeout(timeoutMs),
    })
  }
  catch (err) {
    throw classify(err)
  }
  if (res.status >= 300 && res.status < 400) throw new OllamaError('Ollama a répondu par une redirection (refusée) : vérifier l\'adresse', 'http')

  let text: string
  try {
    text = await res.text()
  }
  catch (err) {
    throw classify(err)
  }
  if (text.length > MAX_RESPONSE_BYTES) throw new OllamaError('Réponse d\'Ollama trop volumineuse', 'bad-response')

  let json: unknown
  try {
    json = text ? JSON.parse(text) : null
  }
  catch {
    json = null
  }
  if (res.status >= 400) {
    const detail = redactPatterns(typeof (json as { error?: unknown } | null)?.error === 'string' ? (json as { error: string }).error : '').slice(0, 200)
    if (res.status === 401 || res.status === 403) throw new OllamaError('Accès refusé par le serveur Ollama (jeton absent ou invalide)', 'auth')
    if (res.status === 404 && /model/i.test(detail)) throw new OllamaError(`Modèle introuvable sur le serveur Ollama${detail ? ` (${detail})` : ''}`, 'model-missing')
    throw new OllamaError(`Ollama : réponse ${res.status}${detail ? ` (${detail})` : ''}`, 'http')
  }
  if (json === null) throw new OllamaError('Réponse d\'Ollama illisible (JSON attendu) : vérifier que l\'adresse est bien celle d\'Ollama', 'bad-response')
  return json
}

const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null)

export function createOllamaHttpAdapter(): OllamaAdapter {
  return {
    async version(conn) {
      const r = await call(conn, 'GET', '/api/version', undefined, Math.min(conn.timeoutMs, VERSION_TIMEOUT_MS)) as { version?: unknown }
      return typeof r.version === 'string' ? r.version.slice(0, 40) : null
    },

    async models(conn): Promise<OllamaModel[]> {
      const r = await call(conn, 'GET', '/api/tags', undefined, Math.min(conn.timeoutMs, VERSION_TIMEOUT_MS)) as { models?: { name?: unknown, size?: unknown }[] }
      return (Array.isArray(r.models) ? r.models : [])
        .filter((m): m is { name: string, size?: unknown } => typeof m?.name === 'string')
        .map(m => ({ name: m.name, sizeBytes: num(m.size) }))
    },

    async chat(conn, req: OllamaChatRequest): Promise<OllamaChatResponse> {
      const r = await call(conn, 'POST', '/api/chat', {
        model: req.model,
        messages: req.messages,
        stream: false,
        ...(req.format ? { format: req.format } : {}),
        options: {
          temperature: req.temperature ?? 0.1,
          ...(req.numCtx ? { num_ctx: req.numCtx } : {}),
          ...(req.numPredict ? { num_predict: req.numPredict } : {}),
        },
      }) as { message?: { content?: unknown }, model?: unknown, prompt_eval_count?: unknown, eval_count?: unknown }
      if (typeof r.message?.content !== 'string') throw new OllamaError('Réponse d\'Ollama sans message', 'bad-response')
      return {
        content: r.message.content,
        model: typeof r.model === 'string' ? r.model : req.model,
        promptTokens: num(r.prompt_eval_count),
        completionTokens: num(r.eval_count),
      }
    },
  }
}
