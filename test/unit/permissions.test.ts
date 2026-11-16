import { describe, expect, it } from 'vitest'
import { BUILTIN_ROLES, can, type RoleGrant } from '../../shared/utils/permissions'

const PROD = 'env-prod'
const DEV = 'env-dev'

describe('RBAC', () => {
  const creatorDevOnly: RoleGrant[] = [
    { permissions: BUILTIN_ROLES.viewer.permissions, scope: {} },
    { permissions: BUILTIN_ROLES.creator.permissions, scope: { environmentId: DEV } },
  ]

  it('limite le déploiement à l\'environnement autorisé', () => {
    expect(can(creatorDevOnly, 'deployment:execute', { environmentId: DEV })).toBe(true)
    expect(can(creatorDevOnly, 'deployment:execute', { environmentId: PROD })).toBe(false)
    expect(can(creatorDevOnly, 'logs:read', { environmentId: PROD })).toBe(true)
  })

  it('le rôle création ne donne aucun droit d\'administration', () => {
    expect(can(creatorDevOnly, 'server:manage')).toBe(false)
    expect(can(creatorDevOnly, 'audit:read')).toBe(false)
  })

  it('une portée projet ne déborde pas sur un autre projet', () => {
    const g: RoleGrant[] = [{ permissions: ['project:update'], scope: { projectId: 'p1' } }]
    expect(can(g, 'project:update', { projectId: 'p1' })).toBe(true)
    expect(can(g, 'project:update', { projectId: 'p2' })).toBe(false)
    expect(can(g, 'project:update', {})).toBe(false)
  })

  it('l\'administrateur global a tous les droits', () => {
    const admin: RoleGrant[] = [{ permissions: BUILTIN_ROLES.admin.permissions, scope: {} }]
    expect(can(admin, 'user:manage', { environmentId: PROD })).toBe(true)
  })
})
