/**
 * Ollama simulé (OLLAMA_ADAPTER=mock) : réponse déterministe, sans réseau, pour le développement et les tests.
 * Les appels sont conservés dans `calls` pour vérifier ce qui part vers le modèle (masquage, bornage).
 */
import type { OllamaAdapter, OllamaChatRequest, OllamaConnection, OllamaError } from './types'

export interface MockOllamaAdapter extends OllamaAdapter {
  calls: { conn: OllamaConnection, req: OllamaChatRequest }[]
  /** Remplace la réponse du modèle (texte brut) ; null : réponse par défaut. */
  reply: string | null
  /** Fait échouer le prochain appel de conversation. */
  failWith: OllamaError | null
  models_: string[]
}

export function createMockOllamaAdapter(): MockOllamaAdapter {
  const adapter: MockOllamaAdapter = {
    calls: [],
    reply: null,
    failWith: null,
    models_: ['llama3.1:8b'],
    async version() {
      return '0.0.0-mock'
    },
    async models() {
      return adapter.models_.map(name => ({ name, sizeBytes: 4_700_000_000 }))
    },
    async chat(conn, req) {
      adapter.calls.push({ conn, req })
      if (adapter.failWith) {
        const err = adapter.failWith
        adapter.failWith = null
        throw err
      }
      const logs = req.messages.at(-1)?.content ?? ''
      const failing = /error|fatal|exception/i.test(logs)
      return {
        content: adapter.reply ?? JSON.stringify({
          severity: failing ? 'error' : 'ok',
          summary: failing ? 'Le service s\'arrête sur une erreur au démarrage (réponse simulée).' : 'Aucun problème visible dans cet extrait (réponse simulée).',
          causes: failing ? [{ title: 'Erreur au démarrage', evidence: 'ligne contenant « error »' }] : [],
          actions: failing ? ['Relire les premières lignes d\'erreur', 'Vérifier la configuration du service'] : [],
        }),
        model: req.model,
        promptTokens: Math.ceil(logs.length / 3),
        completionTokens: 60,
      }
    },
  }
  return adapter
}
