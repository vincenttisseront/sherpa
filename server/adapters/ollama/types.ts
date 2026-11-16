/** Contrat de l'adaptateur Ollama : lecture de la version et des modèles, conversation en une réponse. */

export interface OllamaConnection {
  baseUrl: string
  /** Jeton Bearer (proxy placé devant Ollama). */
  token?: string | null
  timeoutMs: number
}

export interface OllamaMessage {
  role: 'system' | 'user' | 'assistant'
  content: string
}

export interface OllamaChatRequest {
  model: string
  messages: OllamaMessage[]
  /** Schéma JSON de la réponse (sortie structurée). */
  format?: object
  /** Fenêtre de contexte demandée (tokens). */
  numCtx?: number
  /** Longueur maximale de la réponse (tokens). */
  numPredict?: number
  temperature?: number
}

export interface OllamaChatResponse {
  content: string
  model: string
  promptTokens: number | null
  completionTokens: number | null
}

export interface OllamaModel {
  name: string
  sizeBytes: number | null
}

export interface OllamaAdapter {
  version(conn: OllamaConnection): Promise<string | null>
  models(conn: OllamaConnection): Promise<OllamaModel[]>
  chat(conn: OllamaConnection, req: OllamaChatRequest): Promise<OllamaChatResponse>
}

export type OllamaErrorCode = 'invalid-url' | 'unreachable' | 'timeout' | 'auth' | 'model-missing' | 'http' | 'bad-response'

/** Erreur d'Ollama : le message est affichable (aucun secret, aucune adresse interne). */
export class OllamaError extends Error {
  constructor(message: string, readonly code: OllamaErrorCode) {
    super(message)
    this.name = 'OllamaError'
  }
}
