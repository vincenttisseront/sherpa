/** Plan d'adressage d'un serveur : tous les réseaux Docker de l'hôte, leurs sous-réseaux et leur déplacement. */
import { z } from 'zod'
import type { NetworkPool } from './network-pool'

export type NetworkOwnerKind = 'project' | 'compose' | 'platform' | 'standalone' | 'system'

export interface PlannedNetwork {
  id: string
  name: string
  driver: string
  subnets: string[]
  /** Adresses utilisables du plus grand sous-réseau. */
  addresses: number | null
  containers: string[]
  owner: { kind: NetworkOwnerKind, project?: string, environment?: string, targetId?: string, network?: string, stack?: string }
  /** Sous-réseau dans la plage de l'endpoint. */
  inPool: boolean
  /** Problèmes : recouvrement, plage à éviter, taille démesurée. */
  issues: { kind: 'avoid' | 'overlap' | 'oversized', message: string }[]
  movable: boolean
  /** Mode de déplacement : redéploiement du projet, ou recréation en direct. */
  moveMode: 'redeploy' | 'live' | null
  notMovableReason: string | null
}

export interface AddressPlanDto {
  pool: NetworkPool | null
  networks: PlannedNetwork[]
  /** Réseaux attribués dans la plage / capacité de la plage. */
  poolUsage: { used: number, capacity: number } | null
}

export const networkMoveInput = z.object({
  network: z.string().min(1).max(255),
  /** Sous-réseau cible ; absent : prochain libre dans la plage de l'endpoint. */
  subnet: z.string().trim().regex(/^(\d{1,3}\.){3}\d{1,3}\/\d{1,2}$/, 'Notation CIDR attendue').nullable().default(null),
  /** Prévisualisation seulement (aucun changement). */
  dryRun: z.boolean().default(false),
})
export type NetworkMoveInput = z.infer<typeof networkMoveInput>

export interface NetworkMovePlan {
  network: string
  from: string[]
  to: string | null
  mode: 'redeploy' | 'live' | null
  containers: { name: string, aliases: string[], running: boolean }[]
  steps: string[]
  blockers: string[]
  warnings: string[]
}

export interface NetworkMoveResult {
  plan: NetworkMovePlan
  /** Déplacement en direct : journal ; redéploiement : déploiement lancé. */
  log?: string[]
  deploymentId?: string
}
