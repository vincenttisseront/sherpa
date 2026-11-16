import type { NetworkDecision } from '../schemas/infra'
import { SYSTEM_NETWORKS } from '../schemas/infra'

const COMPOSE_PROJECT = 'com.docker.compose.project'
const COMPOSE_NETWORK = 'com.docker.compose.network'

/**
 * Proposition initiale pour un réseau découvert (modifiable par l'administrateur) :
 * réseaux système interdits, réseau de Traefik autorisé avec le rôle traefik,
 * réseau privé d'une stack (créé par son Compose et utilisé par elle seule) interdit
 * automatiquement, le reste à examiner (réseau partagé entre stacks, créé à la main…).
 */
export function defaultNetworkDecision(network: { name: string, labels?: Record<string, string>, stacks?: readonly string[] }, traefikNetworks: readonly string[]): NetworkDecision {
  const base = { external: true, description: null, tags: [], allowedEnvironmentKeys: [] }
  if ((SYSTEM_NETWORKS as readonly string[]).includes(network.name)) return { ...base, policy: 'forbidden', role: 'none' }
  if (traefikNetworks.includes(network.name)) return { ...base, policy: 'allowed', role: 'traefik' }
  const owner = network.labels?.[COMPOSE_PROJECT]
  if (owner && network.labels?.[COMPOSE_NETWORK] && (network.stacks ?? []).every(s => s === owner)) {
    return {
      ...base,
      policy: 'forbidden',
      role: 'none',
      description: `Réseau privé de la stack « ${owner} » (créé par son Compose, utilisé par elle seule) : interdit automatiquement, les autres projets ne s'y attachent pas.`,
      tags: ['auto'],
    }
  }
  return { ...base, policy: 'unreviewed', role: 'none' }
}
