/** Nettoyage Docker d'un endpoint (équivalents contrôlés de docker * prune). */
import { z } from 'zod'

export interface CleanupItem {
  id: string
  name: string
  detail: string | null
  sizeBytes: number | null
  /** Raison de la protection (jamais supprimé), ou null. */
  protectedBy: string | null
  /** Image construite par la plateforme (projet d'origine). */
  platformProject?: string | null
}

export interface CleanupPreview {
  endpointId: string
  scannedAt: string
  busy: string | null
  usage: {
    images: { count: number, active: number, sizeBytes: number, reclaimableBytes: number }
    containers: { count: number, running: number, sizeBytes: number, reclaimableBytes: number }
    volumes: { count: number, active: number, sizeBytes: number, reclaimableBytes: number }
    buildCache: { count: number, sizeBytes: number, reclaimableBytes: number }
  }
  containers: CleanupItem[]
  images: { dangling: CleanupItem[], unused: CleanupItem[] }
  volumes: CleanupItem[]
  networks: CleanupItem[]
  buildCache: { count: number, reclaimableBytes: number }
}

export const cleanupInput = z.object({
  containers: z.object({ olderThan24h: z.boolean().default(false) }).optional(),
  images: z.object({ mode: z.enum(['dangling', 'unused']) }).optional(),
  volumes: z.object({ names: z.array(z.string().max(300)).min(1).max(500) }).optional(),
  networks: z.object({ ids: z.array(z.string().max(100)).min(1).max(500) }).optional(),
  buildCache: z.object({ olderThan24h: z.boolean().default(true) }).optional(),
}).refine(v => v.containers || v.images || v.volumes || v.networks || v.buildCache, 'Choisir au moins un nettoyage')
export type CleanupInput = z.infer<typeof cleanupInput>

export interface CleanupStepResult { action: 'containers' | 'images' | 'volumes' | 'networks' | 'buildCache', deleted: number, reclaimedBytes: number, errors: string[] }
export interface CleanupResult { reclaimedBytes: number, steps: CleanupStepResult[] }
