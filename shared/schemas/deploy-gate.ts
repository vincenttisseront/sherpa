import { z } from 'zod'
import type { DeployWindow } from '../utils/deploy-windows'

const hhmm = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Heure HH:MM')
export const deployWindow = z.object({
  days: z.array(z.number().int().min(1).max(7)).min(1, 'Au moins un jour').max(7),
  from: hhmm,
  to: hhmm,
}).refine(w => w.from < w.to, { message: 'La fin doit suivre le début (même journée)', path: ['to'] })

const timezone = z.string().max(64).refine((tz) => {
  try {
    new Intl.DateTimeFormat('fr-FR', { timeZone: tz })
    return true
  }
  catch { return false }
}, 'Fuseau horaire inconnu')

export const deployPolicyInput = z.object({
  environmentId: z.uuid(),
  /** Tout déploiement doit être validé par une autre personne (droit deployment:approve) avant de s'exécuter. */
  requireApproval: z.boolean(),
  timezone,
  windows: z.array(deployWindow).max(10),
})
export type DeployPolicyInput = z.infer<typeof deployPolicyInput>

/** Planification d'un déploiement : à une heure donnée, ou « urgent » (hors fenêtre, avec validation d'une autre personne). */
export const scheduleInput = z.object({
  at: z.iso.datetime().optional(),
  urgent: z.boolean().optional(),
}).optional()
export type ScheduleInput = z.infer<typeof scheduleInput>

export const decisionInput = z.object({
  decision: z.enum(['approve', 'reject', 'cancel']),
  comment: z.string().trim().max(500).optional(),
})

export interface DeployPolicyDto {
  environmentId: string
  environment: string
  isProduction: boolean
  requireApproval: boolean
  timezone: string
  windows: DeployWindow[]
}

/** État de la porte de déploiement d'une cible (environnement), pour l'assistant de déploiement. */
export interface GateInfoDto {
  requireApproval: boolean
  timezone: string
  windows: DeployWindow[]
  open: boolean
  nextOpening: string | null
}

/** Position d'un déploiement en file : validation attendue, ou exécution planifiée. */
export interface GateStateDto {
  /** `decidedBy` et `requestedBy` : adresses email. */
  approval: { state: 'pending' | 'approved' | 'rejected', reason: 'policy' | 'urgent', requestedAt: string, decidedBy: string | null, decidedAt: string | null, comment: string | null } | null
  scheduledFor: string | null
  requestedBy: string | null
}
