/**
 * Décision de la porte de déploiement d'un environnement (fonction pure) : exécution immédiate, exécution planifiée,
 * mise en attente d'une validation par une autre personne, ou refus (hors fenêtre).
 */
import { type DeployWindow, describeWindows, isWindowOpen, nextWindowOpening } from '../../shared/utils/deploy-windows'

/** Actions qui changent ce qui tourne : seules celles-là sont soumises aux fenêtres et à la validation. */
export const GATED_ACTIONS: readonly string[] = ['deploy', 'redeploy', 'delete', 'migrate']
export const MAX_SCHEDULE_DAYS = 30

export interface GatePolicy { requireApproval: boolean, timezone: string, windows: readonly DeployWindow[] }
export interface GateRequest { action: string, requestedBy: string | null, scheduledAt: Date | null, urgent: boolean, now: Date }

export type GateDecision =
  | { kind: 'run' }
  | { kind: 'schedule', at: Date, automatic?: boolean }
  | { kind: 'hold', reason: 'policy' | 'urgent', at: Date | null }
  | { kind: 'refuse', status: 409 | 422, message: string }

export function decideGate(policy: GatePolicy, req: GateRequest): GateDecision {
  if (!GATED_ACTIONS.includes(req.action)) return { kind: 'run' }
  const { windows, timezone } = policy
  const where = `fenêtres de déploiement : ${describeWindows(windows)} (${timezone})`

  if (req.scheduledAt) {
    const delta = req.scheduledAt.getTime() - req.now.getTime()
    if (delta < -60_000) return { kind: 'refuse', status: 422, message: 'La date planifiée est passée' }
    if (delta > MAX_SCHEDULE_DAYS * 86_400_000) return { kind: 'refuse', status: 422, message: `Planification limitée à ${MAX_SCHEDULE_DAYS} jours` }
    if (!isWindowOpen(windows, timezone, req.scheduledAt)) return { kind: 'refuse', status: 422, message: `Heure planifiée hors des ${where}` }
    return policy.requireApproval ? { kind: 'hold', reason: 'policy', at: req.scheduledAt } : { kind: 'schedule', at: req.scheduledAt }
  }

  if (!isWindowOpen(windows, timezone, req.now)) {
    if (req.urgent) return { kind: 'hold', reason: 'urgent', at: null }
    // Automatisme (webhook, reconstruction automatique) : reporté à la prochaine ouverture, pas refusé.
    if (req.requestedBy === null) {
      const at = nextWindowOpening(windows, timezone, req.now)
      if (!at) return { kind: 'refuse', status: 409, message: `Aucune ouverture dans les 8 jours (${where})` }
      return policy.requireApproval ? { kind: 'hold', reason: 'policy', at } : { kind: 'schedule', at, automatic: true }
    }
    return { kind: 'refuse', status: 409, message: `Hors des ${where} : planifier le déploiement dans une fenêtre, ou le demander en urgence (validation par une autre personne).` }
  }
  return policy.requireApproval ? { kind: 'hold', reason: 'policy', at: null } : { kind: 'run' }
}
