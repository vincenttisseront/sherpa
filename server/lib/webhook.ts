/**
 * Webhook GitHub (déploiement au push) : signature des livraisons, lecture de la charge utile et
 * choix des environnements à déployer. Fonctions pures, sans accès réseau ni base.
 */
import { createHmac, timingSafeEqual } from 'node:crypto'

/** `X-Hub-Signature-256: sha256=<hex>` : HMAC-SHA256 du corps brut avec le secret du webhook, comparé à temps constant. */
export function verifySignature(secret: string, rawBody: string | Buffer, header: string | undefined): boolean {
  const m = /^sha256=([0-9a-f]{64})$/i.exec(header ?? '')
  if (!m) return false
  const expected = createHmac('sha256', secret).update(rawBody).digest()
  return timingSafeEqual(expected, Buffer.from(m[1]!, 'hex'))
}

export const signatureOf = (secret: string, rawBody: string | Buffer) => `sha256=${createHmac('sha256', secret).update(rawBody).digest('hex')}`

export type WebhookEvent =
  | { kind: 'ping' }
  | { kind: 'push', repository: string, branch: string | null, sha: string | null, deleted: boolean, message: string }
  | { kind: 'release', repository: string, tag: string, prerelease: boolean, draft: boolean, action: string }
  | { kind: 'other', name: string }

/** Charge utile d'une livraison : seuls les champs utiles sont lus, le reste est ignoré. */
export function parseEvent(name: string, body: unknown): WebhookEvent {
  const b = (body && typeof body === 'object' ? body : {}) as Record<string, unknown>
  const repo = (b.repository && typeof (b.repository as { full_name?: unknown }).full_name === 'string' ? (b.repository as { full_name: string }).full_name : '')
  if (name === 'ping') return { kind: 'ping' }
  if (name === 'push') {
    const ref = typeof b.ref === 'string' ? b.ref : ''
    const sha = typeof b.after === 'string' && /^[0-9a-f]{40}$/i.test(b.after) ? b.after.toLowerCase() : null
    const head = b.head_commit && typeof b.head_commit === 'object' ? (b.head_commit as { message?: unknown }).message : ''
    return { kind: 'push', repository: repo, branch: ref.startsWith('refs/heads/') ? ref.slice('refs/heads/'.length) : null, sha, deleted: b.deleted === true || sha === '0'.repeat(40), message: typeof head === 'string' ? head : '' }
  }
  if (name === 'release') {
    const r = (b.release && typeof b.release === 'object' ? b.release : {}) as Record<string, unknown>
    return { kind: 'release', repository: repo, tag: typeof r.tag_name === 'string' ? r.tag_name : '', prerelease: r.prerelease === true, draft: r.draft === true, action: typeof b.action === 'string' ? b.action : '' }
  }
  return { kind: 'other', name }
}

/** Message de commit demandant de ne pas déployer. */
export const skipRequested = (message: string) => /\[(skip deploy|no deploy|skip cd)\]/i.test(message)

export interface WebhookTargetInfo {
  targetId: string
  environment: string
  enabled: boolean
  /** Branche propre à l'environnement. */
  branch: string | null
}
export interface SourceInfo { repository: string | null, refType: 'branch' | 'tag' | 'commit' | null, ref: string | null }

/** Branche suivie par une cible : la sienne, sinon celle de la source du projet si elle suit une branche. */
export const effectiveBranch = (t: Pick<WebhookTargetInfo, 'branch'>, source: SourceInfo | null): string | null => t.branch ?? (source?.refType === 'branch' ? source.ref : null)

export type Selection =
  | { action: 'pong' }
  | { action: 'ignore', reason: string }
  | { action: 'deploy', targets: WebhookTargetInfo[], branch: string | null }

/** Environnements concernés par une livraison, ou la raison pour laquelle elle est ignorée. */
export function selectTargets(event: WebhookEvent, source: SourceInfo | null, targets: readonly WebhookTargetInfo[]): Selection {
  if (event.kind === 'ping') return { action: 'pong' }
  if (event.kind === 'other') return { action: 'ignore', reason: `Évènement « ${event.name} » non géré (seuls push et release déclenchent un déploiement)` }
  if (!source?.repository) return { action: 'ignore', reason: 'Le projet ne suit pas de dépôt GitHub' }
  if (event.repository.toLowerCase() !== source.repository.toLowerCase()) return { action: 'ignore', reason: `Dépôt ${event.repository || 'inconnu'} différent de celui du projet (${source.repository})` }
  const enabled = targets.filter(t => t.enabled)
  if (!enabled.length) return { action: 'ignore', reason: 'Aucun environnement n\'a le déploiement au push activé' }

  if (event.kind === 'push') {
    if (event.deleted) return { action: 'ignore', reason: 'Branche supprimée' }
    if (!event.branch) return { action: 'ignore', reason: 'Push de tag : seules les branches déclenchent un déploiement' }
    if (skipRequested(event.message)) return { action: 'ignore', reason: 'Message de commit contenant [skip deploy]' }
    const match = enabled.filter(t => effectiveBranch(t, source) === event.branch)
    if (!match.length) return { action: 'ignore', reason: `Aucun environnement ne suit la branche ${event.branch}` }
    return { action: 'deploy', targets: match, branch: event.branch }
  }

  // release : environnements qui suivent les releases du dépôt (source par tag, sans branche propre).
  if (event.action !== 'published' && event.action !== 'released') return { action: 'ignore', reason: `Release : action « ${event.action} » ignorée` }
  if (event.draft || event.prerelease) return { action: 'ignore', reason: 'Release brouillon ou préversion' }
  const match = enabled.filter(t => t.branch === null && source.refType === 'tag')
  if (!match.length) return { action: 'ignore', reason: 'Aucun environnement ne suit les releases du dépôt' }
  return { action: 'deploy', targets: match, branch: null }
}

export type GithubState = 'queued' | 'in_progress' | 'success' | 'failure' | 'error' | 'inactive'
/** État GitHub d'un déploiement de la console. */
export function githubStateOf(status: string): { state: GithubState, description: string } | null {
  switch (status) {
    case 'QUEUED': case 'DRAFT': case 'VALIDATING': return { state: 'queued', description: 'En file d\'attente' }
    case 'PREPARING_FILES': case 'BUILDING': case 'DEPLOYING': case 'HEALTH_CHECKING': case 'ROLLING_BACK': return { state: 'in_progress', description: 'Déploiement en cours' }
    case 'HEALTHY': return { state: 'success', description: 'Déployé, services sains' }
    case 'DEGRADED': return { state: 'failure', description: 'Déployé, mais un service est en échec' }
    case 'ROLLED_BACK': return { state: 'failure', description: 'Échec : retour à la version précédente' }
    case 'FAILED': case 'VALIDATION_FAILED': return { state: 'failure', description: 'Échec du déploiement' }
    case 'CANCELLED': return { state: 'error', description: 'Déploiement annulé' }
    default: return null
  }
}
