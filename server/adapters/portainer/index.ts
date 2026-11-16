import { env } from '../../utils/env'
import { createAgentAdapter } from './agent'
import { createMockPortainerAdapter } from './mock'
import { createSshAdapter } from './ssh'
import type { PortainerAdapter, PortainerConnection } from './types'

let adapter: PortainerAdapter | undefined

/**
 * Aiguillage par transport : chaque opération reçoit la connexion en premier
 * argument et part vers l'agent Portainer ou vers SSH selon `conn.transport`.
 */
function routed(agent: PortainerAdapter, ssh: PortainerAdapter): PortainerAdapter {
  return new Proxy({} as PortainerAdapter, {
    get(_t, prop: string) {
      return (conn: PortainerConnection, ...args: unknown[]) => {
        const impl = conn?.transport === 'ssh' ? ssh : agent
        return (impl[prop as keyof PortainerAdapter] as (...a: unknown[]) => unknown)(conn, ...args)
      }
    },
  })
}

/** Adaptateur des hôtes : agents Portainer ou SSH joints directement (ou mock en test). */
export function portainer(): PortainerAdapter {
  if (!adapter) {
    const e = env()
    const opts = { timeoutMs: e.PORTAINER_TIMEOUT_MS, maxRetries: e.PORTAINER_MAX_RETRIES }
    adapter = e.PORTAINER_ADAPTER === 'http'
      ? routed(createAgentAdapter(opts), createSshAdapter(opts))
      : createMockPortainerAdapter()
  }
  return adapter
}

export * from './types'
