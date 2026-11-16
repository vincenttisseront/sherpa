import { describe, expect, it } from 'vitest'
import { checkPasswordPolicy, hashPassword, verifyPassword } from '../../server/auth/password'
import { canOnProject } from '../../server/services/access'
import { BUILTIN_ROLES } from '../../shared/utils/permissions'
import type { AuthUser } from '../../server/utils/auth'

describe('politique de mot de passe', () => {
  it.each([
    ['court', 'Abc123!', /12 caractères/],
    ['répétitif', 'aaaaaaaaaaaaaa', /simple/],
    ['courant', 'motdepasse123', /courant/],
    ['contient l\'identifiant', 'jean.dupont-2026!', /identifiant/],
    ['peu varié', 'abababababab', /varié/],
  ])('refuse un mot de passe %s', (_l, pwd, re) => {
    expect(checkPasswordPolicy(pwd, 'jean.dupont@acme.fr')).toMatch(re)
  })
  it('accepte une phrase de passe longue', () => {
    expect(checkPasswordPolicy('cheval correct batterie agrafe', 'jean@acme.fr')).toBeNull()
  })
})

describe('Argon2id', () => {
  it('hache en Argon2id et vérifie', async () => {
    const h = await hashPassword('cheval correct batterie agrafe')
    expect(h.startsWith('$argon2id$')).toBe(true)
    expect(await verifyPassword(h, 'cheval correct batterie agrafe')).toBe(true)
    expect(await verifyPassword(h, 'mauvais mot de passe !')).toBe(false)
  })
  it('renvoie faux sans hash (compte absent), sans erreur', async () => {
    expect(await verifyPassword(null, 'compte-inexistant-pour-egaliser-le-temps')).toBe(false)
  })
})

describe('visibilité par portée', () => {
  const user = (grants: AuthUser['grants']): AuthUser => ({ id: 'u', email: 'u@x', displayName: 'U', kind: 'local', grants })
  const scopes = [
    { projectId: 'p1', environmentId: 'dev', serverId: 's1' },
    { projectId: 'p1', environmentId: 'prod', serverId: 's2' },
    { projectId: 'p2', environmentId: 'prod', serverId: 's2' },
  ]
  it('un rôle limité à dev ne voit que les projets ayant une cible dev', () => {
    const u = user([{ permissions: BUILTIN_ROLES.viewer.permissions, scope: { environmentId: 'dev' } }])
    expect(canOnProject(u, 'project:read', 'p1', scopes)).toBe(true)
    expect(canOnProject(u, 'project:read', 'p2', scopes)).toBe(false)
  })
  it('un rôle limité à un projet ne déborde pas', () => {
    const u = user([{ permissions: BUILTIN_ROLES.creator.permissions, scope: { projectId: 'p2' } }])
    expect(canOnProject(u, 'deployment:execute', 'p2', scopes)).toBe(true)
    expect(canOnProject(u, 'deployment:execute', 'p1', scopes)).toBe(false)
  })
  it('un rôle limité à un serveur couvre les projets qui y sont déployés', () => {
    const u = user([{ permissions: BUILTIN_ROLES.viewer.permissions, scope: { serverId: 's1' } }])
    expect(canOnProject(u, 'project:read', 'p1', scopes)).toBe(true)
    expect(canOnProject(u, 'project:read', 'p2', scopes)).toBe(false)
  })
})
