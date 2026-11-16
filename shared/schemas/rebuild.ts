import { z } from 'zod'

/** Reconstruction d'une cible sur la dernière version de sa source. */
export interface RebuildVersion { label: string, ref: string, at: string | null, url: string | null }

export interface RebuildPlan {
  /** branche : dernier commit ; release : dernière release (tag ou archive attachée) ; same : même source reconstruite. */
  mode: 'github-branch' | 'github-release' | 'release-archive' | 'same'
  source: string
  current: RebuildVersion | null
  latest: RebuildVersion | null
  upToDate: boolean
  builds: number
  warnings: string[]
  auto?: AutoRebuildState | null
}

/** Reconstruction automatique à chaque nouvelle version (vérifiée par le worker). */
export interface AutoRebuildState {
  enabled: boolean
  cleanBuild: boolean
  lastCheckAt: string | null
  /** Dernière version traitée : reconstruite, ou refusée (nouvelle revue nécessaire) ; pas de nouvelle tentative pour elle. */
  last: { ref: string, label: string, at: string, deploymentId: string | null, outcome: 'started' | 'refused' | 'error', message: string | null } | null
  error: string | null
}

export const autoRebuildInput = z.object({ enabled: z.boolean(), cleanBuild: z.boolean().default(false) })

export const rebuildInput = z.object({
  /** Images de base récupérées à nouveau, sans cache des couches. */
  cleanBuild: z.boolean().default(false),
})
