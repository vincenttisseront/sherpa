import { z } from 'zod'
import { tableQuery } from './common'
import { trimTrailingSlashes } from '../utils/trim'

export const userListQuery = tableQuery.extend({
  status: z.enum(['invited', 'active', 'suspended', 'locked', 'expired']).optional(),
  kind: z.enum(['local', 'sso', 'external']).optional(),
})

export const userCreateInput = z.object({
  email: z.email().trim().toLowerCase(),
  displayName: z.string().trim().min(2).max(100),
  kind: z.enum(['local', 'external']),
  /** Obligatoire pour un compte externe (§15). */
  expiresAt: z.iso.datetime().nullable().default(null),
  groupIds: z.array(z.uuid()).max(50).default([]),
}).refine(v => v.kind !== 'external' || v.expiresAt !== null, { message: 'Un compte externe doit avoir une date d\'expiration', path: ['expiresAt'] })

export const userPatchInput = z.object({
  displayName: z.string().trim().min(2).max(100).optional(),
  status: z.enum(['active', 'suspended']).optional(),
  expiresAt: z.iso.datetime().nullable().optional(),
})

export const groupInput = z.object({ name: z.string().trim().min(2).max(100), description: z.string().trim().max(500).nullable().default(null) })

export const roleInput = z.object({
  key: z.string().regex(/^[a-z0-9-]{2,50}$/, 'minuscules, chiffres, tirets'),
  name: z.string().trim().min(2).max(100),
  description: z.string().trim().max(500).nullable().default(null),
  permissions: z.array(z.string()).min(1).max(100),
})

export const bindingInput = z.object({
  roleId: z.uuid(),
  subjectType: z.enum(['user', 'group']),
  subjectId: z.uuid(),
  serverId: z.uuid().nullable().default(null),
  environmentKey: z.enum(['dev', 'staging', 'production']).nullable().default(null),
  projectId: z.uuid().nullable().default(null),
})

export const idpInput = z.object({
  key: z.string().regex(/^[a-z0-9-]{2,50}$/, 'minuscules, chiffres, tirets'),
  kind: z.enum(['keycloak', 'okta', 'oidc']),
  name: z.string().trim().min(2).max(100),
  issuerUrl: z.url({ protocol: /^https?$/ }).transform(u => trimTrailingSlashes(u)),
  clientId: z.string().trim().min(1).max(200),
  /** Absent : inchangé. */
  clientSecret: z.string().min(1).max(500).optional(),
  scopes: z.array(z.string().regex(/^[\w:.-]{1,100}$/)).min(1).max(20).default(['openid', 'profile', 'email']),
  groupsClaim: z.string().regex(/^[\w:./-]{1,100}$/).default('groups'),
  requireMappedGroup: z.boolean().default(true),
  allowedEmailDomains: z.array(z.string().trim().toLowerCase().regex(/^[a-z0-9.-]+\.[a-z]{2,}$/)).max(20).default([]),
  enabled: z.boolean().default(true),
}).refine(v => v.scopes.includes('openid'), { message: 'Le scope « openid » est obligatoire', path: ['scopes'] })

export const mappingsInput = z.array(z.object({ externalGroup: z.string().trim().min(1).max(300), groupId: z.uuid() })).max(200)

export interface AdminUserRow {
  id: string
  email: string
  displayName: string
  kind: 'local' | 'sso' | 'external'
  status: string
  locked: boolean
  expiresAt: string | null
  lastLoginAt: string | null
  idp: string | null
  groups: string[]
  createdAt: string
}
