import { describe, expect, it } from 'vitest'
import { API_TOKEN_PRESETS, apiTokenInput } from '../../shared/schemas/api-tokens'
import { narrowGrants, tokenStatus } from '../../server/lib/api-token'
import { PERMISSIONS, can } from '../../shared/utils/permissions'

const ALL = null
const grant = (permissions: string[], scope: { projectId?: string | null, environmentId?: string | null, serverId?: string | null } = {}) => ({ permissions, scope: { serverId: null, environmentId: null, projectId: null, ...scope } })
const deploy = { permissions: [...API_TOKEN_PRESETS.deploy.permissions], projectId: ALL, environmentId: ALL }

describe('narrowGrants', () => {
  it('un jeton n\'ajoute jamais de droit : seulement l\'intersection avec les rôles du propriétaire', () => {
    const owner = [grant(['project:read', 'deployment:read', 'deployment:execute', 'user:manage', 'policy:manage'])]
    const g = narrowGrants(owner, deploy)
    expect(g).toHaveLength(1)
    expect(g[0]!.permissions.sort()).toEqual(['deployment:execute', 'deployment:read', 'project:read'])
    expect(can(g, 'user:manage')).toBe(false)
    expect(can(g, 'deployment:stop')).toBe(false)
    // Propriétaire simple lecteur : le profil « déploiement » ne lui donne pas de quoi déployer.
    expect(can(narrowGrants([grant(['project:read', 'deployment:read'])], deploy), 'deployment:execute')).toBe(false)
  })
  it('profils : aucune permission d\'administration', () => {
    const admin = PERMISSIONS.filter(p => /manage|audit|create|delete|import/.test(p))
    for (const preset of Object.values(API_TOKEN_PRESETS)) expect(preset.permissions.filter(p => admin.includes(p))).toEqual([])
  })
  it('portée : projet du jeton, ou intersection avec celle du rôle', () => {
    const owner = [grant([...deploy.permissions]), grant([...deploy.permissions], { projectId: 'p-b' })]
    // Jeton limité à p-a : le rôle global est réduit à p-a, le rôle limité à p-b disparaît.
    const g = narrowGrants(owner, { ...deploy, projectId: 'p-a' })
    expect(g).toHaveLength(1)
    expect(can(g, 'deployment:execute', { projectId: 'p-a' })).toBe(true)
    expect(can(g, 'deployment:execute', { projectId: 'p-b' })).toBe(false)
    expect(can(g, 'deployment:execute', { projectId: 'p-c' })).toBe(false)
    // Jeton sans projet : les portées des rôles sont conservées.
    const all = narrowGrants(owner, deploy)
    expect(can(all, 'deployment:execute', { projectId: 'p-b' })).toBe(true)
    expect(can(narrowGrants([grant([...deploy.permissions], { projectId: 'p-b' })], deploy), 'deployment:execute', { projectId: 'p-a' })).toBe(false)
  })
  it('environnement et serveur du rôle conservés ; jeton limité à un environnement', () => {
    const g = narrowGrants([grant([...deploy.permissions], { serverId: 's1' })], { ...deploy, environmentId: 'e-stg' })
    expect(can(g, 'deployment:execute', { serverId: 's1', environmentId: 'e-stg' })).toBe(true)
    expect(can(g, 'deployment:execute', { serverId: 's1', environmentId: 'e-prod' })).toBe(false)
    expect(can(g, 'deployment:execute', { serverId: 's2', environmentId: 'e-stg' })).toBe(false)
    expect(narrowGrants([grant([...deploy.permissions], { environmentId: 'e-prod' })], { ...deploy, environmentId: 'e-stg' })).toEqual([])
  })
  it('propriétaire sans rôle : aucun droit', () => {
    expect(narrowGrants([], deploy)).toEqual([])
  })
})

describe('jeton : validité et saisie', () => {
  const now = Date.UTC(2026, 10, 14)
  it('état : actif, expiré, révoqué (la révocation l\'emporte)', () => {
    expect(tokenStatus({ revokedAt: null, expiresAt: new Date(now + 1000) }, now)).toBe('active')
    expect(tokenStatus({ revokedAt: null, expiresAt: new Date(now) }, now)).toBe('expired')
    expect(tokenStatus({ revokedAt: new Date(now - 1), expiresAt: new Date(now + 1000) }, now)).toBe('revoked')
  })
  it('saisie : durée bornée à un an, nom et profil obligatoires', () => {
    expect(apiTokenInput.safeParse({ name: 'ci', preset: 'deploy', expiresInDays: 90 }).success).toBe(true)
    expect(apiTokenInput.safeParse({ name: 'ci', preset: 'deploy', expiresInDays: 366 }).success).toBe(false)
    expect(apiTokenInput.safeParse({ name: 'c', preset: 'deploy', expiresInDays: 90 }).success).toBe(false)
    expect(apiTokenInput.safeParse({ name: 'ci', preset: 'admin', expiresInDays: 90 }).success).toBe(false)
    expect(apiTokenInput.safeParse({ name: 'ci', preset: 'read', expiresInDays: 0 }).success).toBe(false)
  })
})
