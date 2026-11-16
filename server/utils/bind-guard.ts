/**
 * Contrôle des volumes bind (§10) : un montage d'un chemin de l'hôte n'est
 * accepté que s'il est couvert par une règle active de la liste blanche de
 * l'endpoint, compatible avec l'environnement, le projet et le mode demandé.
 *
 * Exception implicite : le répertoire runtime propre au projet
 * (<runtimeRoot>/<projet>) est toujours autorisé en lecture-écriture, c'est
 * sa raison d'être (§6.3).
 */
import { PathViolation, assertNotSensitive, isWithin, normalizeAbsolute, tooBroad } from './path-guard'

export interface VolumeRuleLike {
  hostPath: string
  mode: 'ro' | 'rw'
  environmentId: string | null
  projectId: string | null
  enabled: boolean
}

export interface BindRequest {
  hostPath: string
  mode: 'ro' | 'rw'
  environmentId: string
  projectId: string
  /** <runtimeRoot>/<projet> pour cet environnement, si les chemins sont configurés. */
  projectRuntimeDir?: string | null
  /** Racines de travail/build/tmp : jamais montables (sources et releases). */
  workingRoots?: readonly string[]
}

export interface BindDecision { allowed: boolean, reason: string }

export function evaluateBind(req: BindRequest, rules: readonly VolumeRuleLike[]): BindDecision {
  let path: string
  try {
    path = normalizeAbsolute(req.hostPath)
    assertNotSensitive(path)
  }
  catch (e) {
    return { allowed: false, reason: e instanceof PathViolation ? `${e.reason} (${e.path})` : 'Chemin invalide' }
  }
  if (path.endsWith('.sock')) return { allowed: false, reason: 'Montage d\'un socket interdit' }
  // Le dossier de données du projet d'abord : avec un chemin de projet choisi, il peut se trouver
  // sous la racine de travail (à côté de releases/, qui reste, lui, non montable).
  if (req.projectRuntimeDir && isWithin(path, req.projectRuntimeDir)) return { allowed: true, reason: 'Répertoire runtime du projet' }
  if (req.workingRoots?.some(r => isWithin(path, r))) return { allowed: false, reason: 'Les répertoires de travail, de build et temporaires ne sont pas montables' }

  const candidates = rules.filter(r => r.enabled
    && isWithin(path, r.hostPath)
    && (r.environmentId === null || r.environmentId === req.environmentId)
    && (r.projectId === null || r.projectId === req.projectId))
  if (!candidates.length) return { allowed: false, reason: `Chemin ${path} absent de la liste blanche de l'endpoint` }
  if (req.mode === 'rw' && !candidates.some(r => r.mode === 'rw')) return { allowed: false, reason: `Chemin ${path} autorisé en lecture seule uniquement` }
  return { allowed: true, reason: 'Couvert par la liste blanche' }
}

/** Validation d'une règle saisie par un administrateur. */
export function validateVolumeRulePath(hostPath: string, workingRoots: readonly string[]): string | null {
  try {
    const p = normalizeAbsolute(hostPath)
    assertNotSensitive(p)
    if (p.endsWith('.sock')) return 'Un socket ne peut pas être autorisé'
    const broad = tooBroad(p)
    if (broad) return broad
    const clash = workingRoots.find(r => isWithin(p, r) || isWithin(r, p))
    if (clash) return `Recouvre un répertoire de travail/build/temporaire (${clash})`
    return null
  }
  catch (e) {
    return e instanceof PathViolation ? e.reason : 'Chemin invalide'
  }
}
