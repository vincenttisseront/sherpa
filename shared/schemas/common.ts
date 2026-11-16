import { z } from 'zod'

export const uuid = z.uuid()

/** Paramètres communs à tous les tableaux (§17) : pagination, tri, recherche, période. */
export const tableQuery = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(200).default(25),
  sort: z.string().regex(/^[a-zA-Z_]+:(asc|desc)$/).optional(),
  q: z.string().trim().max(200).optional(),
  /** Période relative (conservée telle quelle dans les vues sauvegardées). */
  period: z.enum(['24h', '7d', '30d', '90d', '6m']).optional(),
  from: z.iso.datetime({ offset: true }).optional(),
  to: z.iso.datetime({ offset: true }).optional(),
})

export const PERIOD_LABEL = { '24h': '24 heures', '7d': '7 jours', '30d': '30 jours', '90d': '90 jours', '6m': '6 mois' } as const
export type Period = keyof typeof PERIOD_LABEL
export const PERIOD_MS: Record<Period, number> = { '24h': 864e5, '7d': 7 * 864e5, '30d': 30 * 864e5, '90d': 90 * 864e5, '6m': 183 * 864e5 }
export type TableQuery = z.infer<typeof tableQuery>

export interface Paginated<T> {
  items: T[]
  total: number
  page: number
  pageSize: number
}

export const slug = z.string().regex(/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/, 'Identifiant invalide (minuscules, chiffres, tirets)')

export const ENVIRONMENT_KEYS = ['dev', 'staging', 'production'] as const
export const environmentKey = z.enum(ENVIRONMENT_KEYS)
