import { z } from 'zod'

/** Règles d'alerte de ressources, évaluées à chaque relevé (1 minute) sur les conteneurs déployés par la plateforme. */
export const METRIC_KINDS = ['cpu', 'memory', 'restarts'] as const
export type MetricKind = (typeof METRIC_KINDS)[number]

export const METRIC_LABEL: Record<MetricKind, { name: string, unit: string, hint: string }> = {
  cpu: { name: 'CPU', unit: '%', hint: 'Part du processeur utilisée par le conteneur (100 % = un cœur) pendant toute la durée.' },
  memory: { name: 'Mémoire', unit: '%', hint: 'Mémoire utilisée en pourcentage de la limite du conteneur (de la mémoire de l\'hôte sans limite).' },
  restarts: { name: 'Redémarrages', unit: 'redémarrages', hint: 'Nombre de redémarrages du conteneur sur la durée (boucle de plantage).' },
}

export const metricRule = z.object({
  id: z.string().regex(/^[a-z0-9-]{2,40}$/),
  name: z.string().trim().min(2).max(80),
  metric: z.enum(METRIC_KINDS),
  threshold: z.number().min(0.01).max(10_000),
  minutes: z.number().int().min(2).max(60),
  enabled: z.boolean(),
})
export type MetricRule = z.infer<typeof metricRule>

export const metricRulesInput = z.object({ rules: z.array(metricRule).max(20) }).refine(v => new Set(v.rules.map(r => r.id)).size === v.rules.length, 'Identifiants en double')
export type MetricRulesInput = z.infer<typeof metricRulesInput>

export const DEFAULT_METRIC_RULES: MetricRule[] = [
  { id: 'cpu-high', name: 'CPU élevé', metric: 'cpu', threshold: 90, minutes: 10, enabled: true },
  { id: 'memory-high', name: 'Mémoire élevée', metric: 'memory', threshold: 90, minutes: 5, enabled: true },
  { id: 'restart-loop', name: 'Redémarrages en boucle', metric: 'restarts', threshold: 3, minutes: 15, enabled: true },
]

export const METRIC_RANGES = { '1h': 60, '6h': 360, '24h': 1440, '7d': 10_080 } as const
export type MetricRange = keyof typeof METRIC_RANGES

export interface MetricPoint { t: string, cpu: number | null, memory: number | null, memoryLimit: number | null, restarts: number | null }
export interface MetricsDto {
  range: MetricRange
  container: string
  /** Relevés disponibles : seuls les conteneurs déployés par la plateforme sont suivis. */
  tracked: boolean
  points: MetricPoint[]
  alerts: ActiveAlertDto[]
}

export interface ActiveAlertDto {
  id: string
  rule: string
  metric: MetricKind
  container: string
  project: string | null
  environment: string | null
  value: number | null
  threshold: number
  since: string
  resolvedAt: string | null
}
export interface MetricAlertsDto { rules: MetricRule[], active: ActiveAlertDto[], recent: ActiveAlertDto[], samples: { containers: number, lastAt: string | null } }
