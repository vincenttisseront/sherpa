/**
 * Catalogue des permissions RBAC (§16). Une permission est toujours évaluée
 * dans une portée : globale, serveur, environnement ou projet.
 */
export const PERMISSIONS = [
  // Consultation
  'project:read',
  'deployment:read',
  'logs:read',
  'dashboard:read',
  'server:read',
  // Création
  'project:create',
  'project:update',
  'source:import',
  'build:execute',
  'deployment:execute',
  'deployment:stop',
  'deployment:delete',
  // Administration
  'server:manage',
  'path:manage',
  'network:manage',
  'volume:manage',
  'port:manage',
  'domain:manage',
  'policy:manage',
  'user:manage',
  'group:manage',
  'role:manage',
  'notification:manage',
  'audit:read',
  /** Terminal interactif dans un conteneur en marche (docker exec) : accès shell, donc très sensible. */
  'container:exec',
  /** Valider ou refuser un déploiement demandé par une autre personne (environnements avec validation). */
  'deployment:approve',
] as const

export type Permission = (typeof PERMISSIONS)[number]

const VIEWER: Permission[] = [
  'project:read',
  'deployment:read',
  'logs:read',
  'dashboard:read',
  'server:read',
]

const CREATOR: Permission[] = [
  ...VIEWER,
  'project:create',
  'project:update',
  'source:import',
  'build:execute',
  'deployment:execute',
  'deployment:stop',
]

export const BUILTIN_ROLES = {
  viewer: { name: 'Consultation', permissions: VIEWER },
  creator: { name: 'Création', permissions: CREATOR },
  admin: { name: 'Administrateur', permissions: [...PERMISSIONS] },
} satisfies Record<string, { name: string, permissions: Permission[] }>

export type BuiltinRoleKey = keyof typeof BUILTIN_ROLES

/** Portée d'un binding de rôle. Un champ null signifie « tous ». */
export interface PermissionScope {
  serverId?: string | null
  environmentId?: string | null
  projectId?: string | null
}

export interface RoleGrant {
  permissions: readonly string[]
  scope: PermissionScope
}

/**
 * Un grant couvre la ressource demandée si chacune de ses dimensions de portée
 * est soit non restreinte (null), soit égale à celle de la ressource.
 */
export function grantCovers(grant: RoleGrant, permission: Permission, target: PermissionScope): boolean {
  if (!grant.permissions.includes(permission)) return false
  const dims = ['serverId', 'environmentId', 'projectId'] as const
  return dims.every((d) => {
    const restricted = grant.scope[d]
    if (restricted == null) return true
    return target[d] === restricted
  })
}

export function can(grants: readonly RoleGrant[], permission: Permission, target: PermissionScope = {}): boolean {
  return grants.some(g => grantCovers(g, permission, target))
}
