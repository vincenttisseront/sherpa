import { z } from 'zod'
import type { Permission } from '../utils/permissions'

/** Profils de droits d'un jeton d'API : jamais d'administration, seulement ce qu'un script de déploiement ou de supervision utilise. */
export const API_TOKEN_PRESETS = {
  deploy: { label: 'Déploiement (CI)', hint: 'Lire les projets et déploiements, lancer un déploiement ou une reconstruction.', permissions: ['project:read', 'deployment:read', 'logs:read', 'deployment:execute'] as Permission[] },
  read: { label: 'Lecture seule', hint: 'Lire les projets, déploiements, logs, tableau de bord et serveurs.', permissions: ['project:read', 'deployment:read', 'logs:read', 'dashboard:read', 'server:read'] as Permission[] },
} as const
export type ApiTokenPreset = keyof typeof API_TOKEN_PRESETS

export const API_TOKEN_PREFIX = 'shp_'
export const API_TOKEN_MAX_DAYS = 365

export const apiTokenInput = z.object({
  name: z.string().trim().min(2, 'Nom trop court').max(80),
  preset: z.enum(['deploy', 'read']),
  /** Restriction à un projet et/ou un environnement (null : tout ce que son propriétaire peut faire). */
  projectId: z.uuid().nullable().default(null),
  environmentId: z.uuid().nullable().default(null),
  expiresInDays: z.number().int().min(1).max(API_TOKEN_MAX_DAYS),
})
export type ApiTokenInput = z.infer<typeof apiTokenInput>

export interface ApiTokenDto {
  id: string
  name: string
  prefix: string
  permissions: string[]
  project: { id: string, name: string } | null
  environment: { id: string, name: string } | null
  createdAt: string
  expiresAt: string
  lastUsedAt: string | null
  lastUsedIp: string | null
  status: 'active' | 'expired' | 'revoked'
}
