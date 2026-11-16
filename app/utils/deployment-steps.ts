/**
 * Étapes d'un déploiement (déploiement, redéploiement, rollback, migration) déduites du
 * statut : terminées, en cours, en erreur (statut au moment de l'échec), à venir.
 * Le détail d'une étape est le dernier message de log émis pendant ce statut.
 */
import { formatDuration } from '#shared/utils/format'
import type { ProgressStep } from '../types/progress'

export interface DeploymentStepsInput {
  status: string
  action: string
  error: string | null
  failedFrom: string | null
  sourceKind: string | null
  statusDetails: Record<string, { message: string, level: string }>
  statusDurations?: Record<string, number>
}

export { formatDuration }

const PIPELINE = ['QUEUED', 'PREPARING_FILES', 'BUILDING', 'DEPLOYING', 'HEALTH_CHECKING'] as const
const WITH_STEPS = ['deploy', 'redeploy', 'rollback', 'migrate']

function label(status: (typeof PIPELINE)[number], sourceKind: string | null, action: string): string {
  if (action === 'migrate' && status === 'PREPARING_FILES') return 'Copie de la release et préparation sur le serveur cible'
  if (action === 'migrate' && status === 'DEPLOYING') return 'Arrêt sur l\'origine, copie des données et démarrage sur la cible'
  switch (status) {
    case 'QUEUED': return 'Mise en file d\'attente'
    case 'PREPARING_FILES': return sourceKind === 'github' ? 'Téléchargement de l\'archive GitHub et préparation des fichiers' : 'Préparation des fichiers sur le serveur'
    case 'BUILDING': return 'Construction des images'
    case 'DEPLOYING': return 'Déploiement de la stack'
    case 'HEALTH_CHECKING': return 'Vérification de santé des services'
  }
}

export function deploymentSteps(d: DeploymentStepsInput): ProgressStep[] | null {
  if (!WITH_STEPS.includes(d.action) || ['DRAFT', 'VALIDATING', 'VALIDATION_FAILED'].includes(d.status)) return null
  const detail = (s: string) => d.statusDetails[s]?.message ?? null
  const failed = ['FAILED', 'ROLLING_BACK', 'ROLLED_BACK'].includes(d.status)
  const failedAt = failed ? Math.max(0, PIPELINE.indexOf((d.failedFrom ?? 'QUEUED') as never)) : -1
  const current = PIPELINE.indexOf(d.status as never)
  const reached = current >= 0 ? current : ['HEALTHY', 'DEGRADED'].includes(d.status) ? PIPELINE.length : -1

  const steps: ProgressStep[] = PIPELINE.map((s, i) => {
    const seconds = d.statusDurations?.[s]
    const base = { label: label(s, d.sourceKind, d.action), detail: detail(s), ...(seconds === undefined ? {} : { duration: formatDuration(seconds) }) }
    if (failed) return i < failedAt ? { ...base, state: 'done' } : i === failedAt ? { ...base, state: 'error', detail: d.error ?? base.detail } : { ...base, state: 'pending', detail: null }
    if (d.status === 'CANCELLED') return { ...base, state: 'pending', detail: null }
    return i < reached ? { ...base, state: 'done' } : i === reached ? { ...base, state: 'active' } : { ...base, state: 'pending', detail: null }
  })

  if (d.status === 'HEALTHY') steps.push({ label: 'Déploiement opérationnel', state: 'done', detail: detail('HEALTHY') })
  else if (d.status === 'DEGRADED') steps.push({ label: 'Déploiement dégradé', state: 'error', detail: d.error })
  else if (d.status === 'CANCELLED') steps.push({ label: 'Déploiement annulé', state: 'error', detail: d.error })
  else if (d.status === 'ROLLING_BACK') steps.push({ label: 'Retour à la release précédente', state: 'active', detail: detail('ROLLING_BACK') })
  else if (d.status === 'ROLLED_BACK') steps.push({ label: 'Release précédente restaurée', state: 'done', detail: detail('ROLLED_BACK') })
  else if (!failed) steps.push({ label: 'Mise en service', state: 'pending' })
  return steps
}
