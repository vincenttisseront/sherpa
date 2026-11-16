/** Utilisateur connecté et contrôle des droits côté interface (le serveur reste seul juge). */
import type { Permission, PermissionScope, RoleGrant } from '#shared/utils/permissions'
import { can as canGrant } from '#shared/utils/permissions'

export interface Me {
  authenticated: boolean
  setupRequired?: boolean
  user?: { id: string | null, email: string, displayName: string, kind: string }
  grants?: RoleGrant[]
  permissions?: string[]
  csrfToken?: string
  /** Administrateur : assistant d'initialisation à faire. */
  onboardingPending?: boolean
  /** La politique exige une double authentification non configurée : seule la page du compte est utilisable. */
  mfaEnrollRequired?: boolean
}

export function useAuth() {
  const me = useState<Me | null>('me', () => null)

  async function refresh() {
    const fetcher = import.meta.server ? useRequestFetch() : $fetch
    me.value = await fetcher<Me>('/api/auth/me').catch(() => ({ authenticated: false }))
    return me.value
  }

  /** Permission dans une portée précise. */
  const can = (permission: Permission, scope: PermissionScope = {}) => !!me.value?.grants && canGrant(me.value.grants, permission, scope)
  /** Permission dans au moins une portée (menus, boutons de création). */
  const hasAny = (permission: Permission) => !!me.value?.permissions?.includes(permission)

  async function logout() {
    const r = await $fetch<{ redirect: string | null }>('/api/auth/logout', { method: 'POST' }).catch(() => ({ redirect: null }))
    me.value = { authenticated: false }
    if (r.redirect) window.location.href = r.redirect
    else await navigateTo('/login')
  }

  return { me, refresh, can, hasAny, logout }
}
