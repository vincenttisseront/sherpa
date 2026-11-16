import { env } from '../../utils/env'
import { createOllamaHttpAdapter } from './http'
import { createMockOllamaAdapter } from './mock'
import type { OllamaAdapter } from './types'

let adapter: OllamaAdapter | undefined

/** Adaptateur Ollama : HTTP vers le serveur configuré, ou simulé (OLLAMA_ADAPTER=mock). */
export function ollama(): OllamaAdapter {
  adapter ??= env().OLLAMA_ADAPTER === 'mock' ? createMockOllamaAdapter() : createOllamaHttpAdapter()
  return adapter
}

export * from './types'
export type { MockOllamaAdapter } from './mock'
