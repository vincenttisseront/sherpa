/**
 * Contexte d'authentification et contrôle d'accès côté serveur.
 * Le frontend masque les actions non autorisées, mais seul ce contrôle fait foi.
 */
import type { H3Event } from 'h3'
import { createError } from 'h3'
import type { Permission, PermissionScope, RoleGrant } from '../../shared/utils/permissions'
import { can } from '../../shared/utils/permissions'
import { audit } from './audit'

export interface AuthUser {
  id: string | null
  email: string
  displayName: string
  kind: 'local' | 'sso' | 'external' | 'dev'
  grants: RoleGrant[]
}

declare module 'h3' {
  interface H3EventContext {
    user?: AuthUser
    session?: { id: string, csrfToken: string, idpId: string | null, mfaPending?: boolean }
    apiToken?: { id: string, name: string }
  }
}

export function requireUser(event: H3Event): AuthUser {
  const user = event.context.user
  if (!user) throw createError({ statusCode: 401, statusMessage: 'Authentification requise' })
  return user
}

export async function requirePermission(event: H3Event, permission: Permission, scope: PermissionScope = {}): Promise<AuthUser> {
  const user = requireUser(event)
  if (!can(user.grants, permission, scope)) {
    await audit({
      actorUserId: user.id,
      actorLabel: user.email,
      action: `access.${permission}`,
      outcome: 'denied',
      serverId: scope.serverId,
      environmentId: scope.environmentId,
      projectId: scope.projectId,
      ip: clientIp(event),
    })
    throw createError({ statusCode: 403, statusMessage: 'Permission insuffisante' })
  }
  return user
}

/**
 * Pour une liste : l'utilisateur doit détenir la permission dans au moins une
 * portée ; la liste est ensuite filtrée élément par élément avec `canOn`.
 */
export async function requireAnyPermission(event: H3Event, permission: Permission): Promise<AuthUser> {
  const user = requireUser(event)
  if (!user.grants.some(g => g.permissions.includes(permission))) {
    await audit({ actorUserId: user.id, actorLabel: user.email, action: `access.${permission}`, outcome: 'denied', ip: clientIp(event) })
    throw createError({ statusCode: 403, statusMessage: 'Permission insuffisante' })
  }
  return user
}

export function canOn(user: AuthUser, permission: Permission, scope: PermissionScope): boolean {
  return can(user.grants, permission, scope)
}

export function clientIp(event: H3Event): string | null {
  return event.node.req.socket.remoteAddress ?? null
}
