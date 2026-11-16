/** Tableaux transverses (§17) : requêtes filtrables et lignes renvoyées. */
import { z } from 'zod'
import { DEPLOYMENT_STATUSES } from '../utils/deployment-status'
import { tableQuery } from './common'

const csvList = <T extends readonly [string, ...string[]]>(values: T) =>
  z.string().max(500).transform(s => s.split(',').filter(Boolean)).pipe(z.array(z.enum(values)).max(values.length)).optional()

export const DEPLOYMENT_ACTIONS = ['deploy', 'redeploy', 'stop', 'start', 'restart', 'delete', 'rollback', 'migrate'] as const

export const deploymentListQuery = tableQuery.extend({
  status: csvList(DEPLOYMENT_STATUSES),
  action: csvList(DEPLOYMENT_ACTIONS),
  projectId: z.uuid().optional(),
  environmentId: z.uuid().optional(),
  serverId: z.uuid().optional(),
  targetId: z.uuid().optional(),
  /** Échecs de build uniquement. */
  buildFailed: z.stringbool().optional(),
  /** Échecs non acquittés uniquement (encore affichés au tableau de bord). */
  unacknowledged: z.stringbool().optional(),
  /** Projets archivés : exclus par défaut (sauf filtre explicite sur un projet ou une cible). */
  archived: z.enum(['all']).optional(),
})
export type DeploymentListQuery = z.infer<typeof deploymentListQuery>

export interface DeploymentRow {
  id: string
  createdAt: string
  finishedAt: string | null
  durationSec: number | null
  action: string
  status: string
  failedFrom: string | null
  error: string | null
  project: string
  projectId: string
  environment: string
  environmentId: string
  server: string
  targetId: string
  releaseNumber: number | null
  requestedBy: string | null
  /** Échec acquitté : retiré du tableau de bord. */
  acknowledgedAt: string | null
  /** En file : validation par une autre personne attendue, ou exécution planifiée. */
  gate: 'pending' | 'scheduled' | null
  scheduledFor: string | null
}

/** Acquittement groupé : sélection explicite, ou tous les échecs non acquittés correspondant aux filtres. */
export const deploymentBulkAcknowledge = z.object({
  ids: z.array(z.uuid()).max(500).optional(),
  filter: deploymentListQuery.partial().optional(),
  acknowledged: z.boolean().default(true),
}).refine(v => !!v.ids?.length !== !!v.filter, { message: 'Sélection ou filtre attendu (un seul)' })
export interface BulkAcknowledgeResult { updated: number, skipped: number }

export const auditListQuery = tableQuery.extend({
  outcome: csvList(['success', 'failure', 'denied'] as const),
  action: z.string().trim().max(100).regex(/^[a-z_.]*$/).optional(),
  actor: z.string().trim().max(200).optional(),
  projectId: z.uuid().optional(),
  environmentId: z.uuid().optional(),
  serverId: z.uuid().optional(),
})
export type AuditListQuery = z.infer<typeof auditListQuery>

export interface AuditRow {
  id: string
  ts: string
  actor: string
  action: string
  outcome: string
  targetType: string | null
  targetId: string | null
  ip: string | null
  details: Record<string, unknown>
}

export const imageUpdateListQuery = tableQuery.extend({
  kind: csvList(['updated', 'available', 'failed', 'external'] as const),
  projectId: z.uuid().optional(),
  environmentId: z.uuid().optional(),
})
export type ImageUpdateListQuery = z.infer<typeof imageUpdateListQuery>

export interface ImageUpdateRow {
  id: string
  detectedAt: string
  kind: string
  service: string
  image: string
  fromImageId: string | null
  toImageId: string | null
  digest: string | null
  detail: string | null
  project: string
  projectId: string
  environment: string
  releaseNumber: number | null
}
