import type { H3Event } from 'h3'
import { PERMISSIONS, type RoleGrant } from '../../shared/utils/permissions'

export interface MeDto {
  authenticated: true
  user: { id: string | null, email: string, displayName: string, kind: string }
  grants: RoleGrant[]
  /** Permissions détenues dans au moins une portée (pour l'affichage des menus). */
  permissions: string[]
  csrfToken: string
  /** Administrateur et assistant d'initialisation non terminé. */
  onboardingPending?: boolean
  /** La politique exige une double authentification que le compte n'a pas configurée : seule la page du compte est accessible. */
  mfaEnrollRequired?: boolean
}

export function meOf(event: H3Event): MeDto | null {
  const u = event.context.user
  if (!u) return null
  return {
    authenticated: true,
    user: { id: u.id, email: u.email, displayName: u.displayName, kind: u.kind },
    grants: u.grants,
    permissions: PERMISSIONS.filter(p => u.grants.some(g => g.permissions.includes(p))),
    csrfToken: event.context.session?.csrfToken ?? '',
    ...(event.context.session?.mfaPending ? { mfaEnrollRequired: true } : {}),
  }
}
