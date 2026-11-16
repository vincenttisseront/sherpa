/**
 * Reprise de l'existant : une stack Compose déjà en place sur un hôte devient
 * un projet géré, sans rien modifier sur le serveur tant qu'aucun déploiement
 * n'est demandé.
 */
import { z } from 'zod'
import type { AnalysisResult, Exposure } from './analysis'
import { environmentKey, slug } from './common'
import { portApprovalInput } from './projects'
import { HOSTNAME_RE, PATH_PREFIX_RE } from '../utils/domains'

export interface AdoptableStack {
  name: string
  services: string[]
  containers: number
  running: number
  images: string[]
  /** Domaines servis aujourd'hui (tous proxies confondus). */
  hosts: string[]
  /** Contient un reverse proxy ou l'agent : à reprendre avec précaution. */
  infrastructure: string | null
  /** Déjà rattachée à un projet de la plateforme. */
  managedBy: { projectId: string, projectName: string, environment: string } | null
  composeFile: string | null
}

export interface AdoptionNote {
  level: 'info' | 'warning' | 'error'
  service: string | null
  message: string
}

export interface AdoptionPreview {
  stack: AdoptableStack
  /** Compose qui sera géré par la plateforme (labels Traefik convertis, chemins relatifs résolus). */
  composeText: string
  exposures: Exposure[]
  /** Variables importées (valeurs chiffrées, jamais renvoyées). */
  variables: string[]
  notes: AdoptionNote[]
  /** Analyse de la plateforme avec les politiques actuelles de l'endpoint. */
  analysis: AnalysisResult
  /** Routes actuelles qui disparaîtront au premier déploiement géré. */
  droppedRoutes: string[]
}

export const adoptionInput = z.object({
  stack: z.string().trim().min(1).max(200),
  projectName: z.string().trim().min(2).max(100),
  slug,
  environmentKey,
  description: z.string().trim().max(1000).nullable().default(null),
  /** Ports custom justifiés et confirmés dans l'assistant (repris au premier déploiement). */
  portApprovals: z.array(portApprovalInput).max(100).default([]),
  /** Ports publiés remplacés par une exposition web derrière le Traefik de l'endpoint (port retiré du Compose). */
  webExposures: z.array(z.object({
    service: z.string().max(100),
    published: z.number().int().min(1).max(65535),
    protocol: z.enum(['tcp', 'udp']).default('tcp'),
    /** Port du conteneur vers lequel le proxy route. */
    port: z.number().int().min(1).max(65535),
    host: z.string().trim().toLowerCase().max(253).regex(HOSTNAME_RE, 'Nom d\'hôte invalide'),
    pathPrefix: z.string().trim().max(200).regex(PATH_PREFIX_RE, 'Préfixe de chemin invalide').nullable().default(null),
  })).max(50).default([]),
  /** Ports publiés retirés de la reprise (interdits ou inutiles). */
  droppedPorts: z.array(z.object({
    service: z.string().max(100),
    published: z.number().int().min(1).max(65535),
    protocol: z.enum(['tcp', 'udp']).default('tcp'),
  })).max(100).default([]),
  /** Montages retirés de la reprise (chemin non autorisable : répertoire système, socket…), par point de montage. */
  droppedMounts: z.array(z.object({ service: z.string().max(100), target: z.string().max(1000) })).max(100).default([]),
})
export type AdoptionInput = z.infer<typeof adoptionInput>

/**
 * Levée d'un point bloquant de la reprise par une règle de l'endpoint : un port
 * autorisé durablement, ou un chemin bind ajouté à la liste blanche.
 */
export const adoptionAllowInput = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('port'),
    port: z.number().int().min(1).max(65535),
    protocol: z.enum(['tcp', 'udp']).default('tcp'),
    environmentKey: environmentKey.nullable().default(null),
    description: z.string().trim().min(3).max(200),
  }),
  z.object({
    kind: z.literal('bind'),
    hostPath: z.string().trim().min(2).max(1024).startsWith('/', 'Chemin absolu attendu'),
    mode: z.enum(['ro', 'rw']).default('ro'),
    environmentKey: environmentKey.nullable().default(null),
    description: z.string().trim().min(3).max(300),
  }),
])
export type AdoptionAllowInput = z.infer<typeof adoptionAllowInput>

export const adoptionConfirm = adoptionInput.extend({
  /** Les routes non convertibles seront retirées au premier déploiement géré. */
  acceptDroppedRoutes: z.boolean().default(false),
})

/** Trace de la reprise conservée sur la cible. */
export interface TargetAdoption {
  at: string
  by: string | null
  stack: string
  composeSha256: string
  exposures: number
  variables: number
  notes: number
}
