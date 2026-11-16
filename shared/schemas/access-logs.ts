import { z } from 'zod'

/** Lecture des logs d'accès : lignes lues, filtres, nombre de requêtes renvoyées. */
export const accessLogQuery = z.object({
  tail: z.coerce.number().int().min(100).max(20_000).default(2000),
  hosts: z.string().max(2000).optional().transform(v => (v ? v.split(',').map(h => h.trim()).filter(Boolean).slice(0, 50) : undefined)),
  status: z.enum(['2xx', '3xx', '4xx', '5xx', 'other']).optional(),
  search: z.string().trim().max(200).optional().transform(v => v || undefined),
  limit: z.coerce.number().int().min(10).max(1000).default(300),
})
