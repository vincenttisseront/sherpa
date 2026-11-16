/** Droits d'un jeton d'API : ceux de son propriétaire, restreints aux permissions et à la portée du jeton. Fonctions pures. */
import type { PermissionScope, RoleGrant } from '../../shared/utils/permissions'

export interface TokenScope { permissions: readonly string[], projectId: string | null, environmentId: string | null }

/** Une dimension de portée : intersection du grant (null = tout) et du jeton (null = tout) ; undefined si disjointes. */
function meet(grant: string | null | undefined, token: string | null): string | null | undefined {
  if (token === null) return grant ?? null
  if (grant == null) return token
  return grant === token ? token : undefined
}

/**
 * Le jeton n'ajoute jamais de droit : chaque rôle de son propriétaire est réduit aux permissions du jeton et à
 * sa portée (projet, environnement) ; un rôle hors de cette portée disparaît. Un propriétaire qui perd un rôle
 * le fait perdre à ses jetons.
 */
export function narrowGrants(owner: readonly RoleGrant[], token: TokenScope): RoleGrant[] {
  const out: RoleGrant[] = []
  for (const g of owner) {
    const permissions = g.permissions.filter(p => token.permissions.includes(p))
    const projectId = meet(g.scope.projectId, token.projectId)
    const environmentId = meet(g.scope.environmentId, token.environmentId)
    if (!permissions.length || projectId === undefined || environmentId === undefined) continue
    const scope: PermissionScope = { serverId: g.scope.serverId ?? null, environmentId, projectId }
    out.push({ permissions, scope })
  }
  return out
}

export const tokenStatus = (t: { revokedAt: Date | null, expiresAt: Date }, now = Date.now()): 'active' | 'expired' | 'revoked' => (t.revokedAt ? 'revoked' : t.expiresAt.getTime() <= now ? 'expired' : 'active')
