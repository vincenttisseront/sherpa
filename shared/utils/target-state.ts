/**
 * État réel d'une cible, le même partout (tableau de bord, fiche projet) : la santé
 * constatée des conteneurs fait foi ; à défaut, la dernière opération.
 */
import type { TargetHealthState } from '../schemas/dashboard'
import { ACTIVE_STATUSES } from './deployment-status'

export type RuntimeState = 'healthy' | 'degraded' | 'down' | 'stopped' | 'failed' | 'deploying' | 'unknown'

export const RUNTIME_STATE: Record<RuntimeState, { label: string, tone: 'success' | 'warning' | 'danger' | 'info' | 'neutral' }> = {
  healthy: { label: 'Sain', tone: 'success' },
  degraded: { label: 'Dégradé', tone: 'warning' },
  down: { label: 'À l\'arrêt', tone: 'danger' },
  stopped: { label: 'Arrêté', tone: 'neutral' },
  failed: { label: 'Échec', tone: 'danger' },
  deploying: { label: 'Déploiement…', tone: 'info' },
  unknown: { label: 'Inconnu', tone: 'neutral' },
}

/** Dernière opération (statut) et santé constatée → état affiché. */
export function runtimeState(lastStatus: string | null | undefined, health: Pick<TargetHealthState, 'status'> | null, hasRelease: boolean): RuntimeState {
  if (lastStatus && (ACTIVE_STATUSES as readonly string[]).includes(lastStatus)) return 'deploying'
  // Arrêt demandé : l'état de santé enregistré avant l'arrêt n'a plus cours.
  if (lastStatus === 'STOPPED') return 'stopped'
  if (health) return health.status === 'healthy' ? 'healthy' : health.status
  if (lastStatus === 'HEALTHY') return 'healthy'
  if (lastStatus === 'DEGRADED') return 'degraded'
  if (!hasRelease && lastStatus && ['FAILED', 'ROLLED_BACK', 'CANCELLED'].includes(lastStatus)) return 'failed'
  return 'unknown'
}
