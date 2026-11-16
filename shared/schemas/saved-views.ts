import { z } from 'zod'

export const TABLE_KEYS = ['servers', 'projects', 'deployments', 'audit', 'images', 'deliveries', 'users'] as const

/** État d'un tableau : filtres, tri, période, taille de page, colonnes masquées (jamais la page courante). */
export const savedViewInput = z.object({
  tableKey: z.enum(TABLE_KEYS),
  name: z.string().trim().min(1).max(60),
  state: z.record(z.string().max(40), z.unknown()).refine(s => JSON.stringify(s).length <= 4000, 'Vue trop volumineuse'),
})

export interface SavedViewDto {
  id: string
  tableKey: string
  name: string
  state: Record<string, unknown>
  createdAt: string
}
