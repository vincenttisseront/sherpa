/**
 * Jetons d'API : authentification par `Authorization: Bearer shp_…` pour les scripts et la CI.
 * Le jeton est généré une fois (affiché à la création), seule son empreinte SHA-256 est conservée.
 * Il agit au nom de son propriétaire, avec au plus ses droits (lib/api-token), tant que le compte est actif.
 */
import { randomBytes } from 'node:crypto'
import { and, desc, eq, isNull } from 'drizzle-orm'
import { createError } from 'h3'
import { API_TOKEN_PREFIX, API_TOKEN_PRESETS, type ApiTokenDto, type ApiTokenInput } from '../../shared/schemas/api-tokens'
import type { RoleGrant } from '../../shared/utils/permissions'
import { db, schema } from '../db/client'
import { narrowGrants, tokenStatus } from '../lib/api-token'
import { sha256Hex } from '../utils/crypto'
import { loadGrants } from './grants'

const TOUCH_EVERY_MS = 60_000

export interface ResolvedApiToken {
  id: string
  name: string
  user: typeof schema.users.$inferSelect
  grants: RoleGrant[]
}

const hashOf = (token: string) => sha256Hex(token)

export async function createApiToken(userId: string, input: ApiTokenInput): Promise<{ token: string, dto: ApiTokenDto }> {
  const permissions = [...API_TOKEN_PRESETS[input.preset].permissions]
  // Un jeton ne donne rien de plus que son propriétaire : refus s'il ne détient pas ces droits.
  const owner = await loadGrants(userId)
  const missing = permissions.filter(p => !owner.some(g => g.permissions.includes(p)))
  if (missing.length) throw createError({ statusCode: 403, statusMessage: `Votre compte n'a pas les droits nécessaires à ce profil (${missing.join(', ')})` })
  const token = `${API_TOKEN_PREFIX}${randomBytes(32).toString('base64url')}`
  try {
    const [row] = await db().insert(schema.apiTokens).values({
      userId, name: input.name, tokenHash: hashOf(token), prefix: token.slice(0, API_TOKEN_PREFIX.length + 6), permissions,
      projectId: input.projectId, environmentId: input.environmentId, expiresAt: new Date(Date.now() + input.expiresInDays * 86_400_000),
    }).returning({ id: schema.apiTokens.id })
    return { token, dto: (await listApiTokens(userId)).find(t => t.id === row!.id)! }
  }
  catch (err) {
    if ((err as { code?: string }).code === '23503') throw createError({ statusCode: 422, statusMessage: 'Projet ou environnement introuvable' })
    throw err
  }
}

export async function listApiTokens(userId: string): Promise<ApiTokenDto[]> {
  const rows = await db().select({ t: schema.apiTokens, project: { id: schema.projects.id, name: schema.projects.name }, env: { id: schema.environments.id, name: schema.environments.name } })
    .from(schema.apiTokens)
    .leftJoin(schema.projects, eq(schema.projects.id, schema.apiTokens.projectId))
    .leftJoin(schema.environments, eq(schema.environments.id, schema.apiTokens.environmentId))
    .where(eq(schema.apiTokens.userId, userId))
    .orderBy(desc(schema.apiTokens.createdAt))
  return rows.map(({ t, project, env }) => ({
    id: t.id, name: t.name, prefix: t.prefix, permissions: t.permissions,
    project: project?.id ? project : null, environment: env?.id ? env : null,
    createdAt: t.createdAt.toISOString(), expiresAt: t.expiresAt.toISOString(), lastUsedAt: t.lastUsedAt?.toISOString() ?? null, lastUsedIp: t.lastUsedIp,
    status: tokenStatus(t),
  }))
}

export async function revokeApiToken(userId: string, id: string): Promise<string | null> {
  const [row] = await db().update(schema.apiTokens).set({ revokedAt: new Date() })
    .where(and(eq(schema.apiTokens.id, id), eq(schema.apiTokens.userId, userId), isNull(schema.apiTokens.revokedAt)))
    .returning({ name: schema.apiTokens.name })
  return row?.name ?? null
}

/** Jeton présenté dans la requête : valide (non révoqué, non expiré, compte actif) avec ses droits effectifs, sinon null. */
export async function resolveApiToken(token: string, ip: string | null): Promise<ResolvedApiToken | null> {
  if (!token.startsWith(API_TOKEN_PREFIX) || token.length > 120) return null
  const [row] = await db().select({ t: schema.apiTokens, u: schema.users }).from(schema.apiTokens)
    .innerJoin(schema.users, eq(schema.users.id, schema.apiTokens.userId))
    .where(eq(schema.apiTokens.tokenHash, hashOf(token)))
  const now = Date.now()
  if (!row || tokenStatus(row.t, now) !== 'active' || row.u.status !== 'active' || (row.u.expiresAt !== null && row.u.expiresAt.getTime() <= now)) return null
  if (!row.t.lastUsedAt || now - row.t.lastUsedAt.getTime() > TOUCH_EVERY_MS) {
    await db().update(schema.apiTokens).set({ lastUsedAt: new Date(now), lastUsedIp: ip }).where(eq(schema.apiTokens.id, row.t.id))
  }
  const grants = narrowGrants(await loadGrants(row.u.id), { permissions: row.t.permissions, projectId: row.t.projectId, environmentId: row.t.environmentId })
  return { id: row.t.id, name: row.t.name, user: row.u, grants }
}
