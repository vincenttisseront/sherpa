/** Assistant d'initialisation (premier démarrage). */
import { z } from 'zod'

export const ONBOARDING_STEPS = ['checks', 'access', 'sso', 'notifications', 'servers', 'github', 'done'] as const
export type OnboardingStep = (typeof ONBOARDING_STEPS)[number]

export const STEP_LABEL: Record<OnboardingStep, string> = {
  checks: 'Vérifications',
  access: 'Accès',
  sso: 'SSO',
  notifications: 'Notifications',
  servers: 'Serveurs',
  github: 'GitHub',
  done: 'Récapitulatif',
}

export const stepStatusInput = z.object({ status: z.enum(['done', 'skipped']) })
export const finishInput = z.object({ mode: z.enum(['completed', 'dismissed']) })

export interface OnboardingState {
  status: 'pending' | 'completed' | 'dismissed'
  steps: Partial<Record<OnboardingStep, 'done' | 'skipped'>>
  updatedAt: string | null
  updatedBy: string | null
}

export interface OnboardingFacts {
  checks: { key: string, label: string, status: 'ok' | 'warning' | 'error' | 'todo' | 'info', detail: string }[]
  groups: { id: string, name: string, roles: string[], members: number }[]
  roles: { id: string, key: string, name: string }[]
  admins: { total: number, local: number }
  idps: { id: string, key: string, name: string, kind: string, enabled: boolean, mappings: number, redirectUri: string }[]
  smtp: boolean
  channels: { id: string, name: string, kind: string, lastStatus: string | null }[]
  webhookHosts: string[]
  servers: { id: string, name: string, status: string, endpointsEnabled: number, runners: number, runnersOnline: number }[]
  githubApis: string[]
  appUrl: string
}

export interface GithubCheck {
  api: string
  ok: boolean
  detail: string
  remaining: number | null
  limit: number | null
}
