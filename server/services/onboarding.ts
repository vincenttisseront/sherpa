/**
 * Assistant d'initialisation : progression persistée (app_settings) et état réel
 * de chaque domaine (groupes, SSO, canaux, serveurs, GitHub) pour guider la saisie.
 * La configuration elle-même passe par les API habituelles (droits, audit).
 */
import { count, eq, inArray } from 'drizzle-orm'
import { fetch } from 'undici'
import type { GithubCheck, OnboardingFacts, OnboardingState, OnboardingStep } from '../../shared/schemas/onboarding'
import { db, schema } from '../db/client'
import { redirectUri } from '../auth/oidc'
import { smtpConfigured } from '../adapters/notifications/email'
import { audit } from '../utils/audit'
import { env } from '../utils/env'
import { globalAdminUserIds } from './admin'
import { listChannels } from './notifications'
import { security } from './readiness'

const KEY = 'onboarding'

interface Stored { status: 'pending' | 'completed' | 'dismissed', steps: Partial<Record<OnboardingStep, 'done' | 'skipped'>> }

export async function getOnboarding(): Promise<OnboardingState> {
  const [row] = await db().select().from(schema.appSettings).where(eq(schema.appSettings.key, KEY))
  const by = row?.updatedBy ? (await db().select({ email: schema.users.email }).from(schema.users).where(eq(schema.users.id, row.updatedBy)))[0]?.email ?? null : null
  if (row) {
    const v = row.value as Stored
    return { status: v.status, steps: v.steps ?? {}, updatedAt: row.updatedAt.toISOString(), updatedBy: by }
  }
  // Installation existante déjà configurée (serveurs déclarés) : pas d'assistant imposé.
  const [{ n }] = await db().select({ n: count() }).from(schema.portainerServers) as [{ n: number }]
  return { status: n ? 'completed' : 'pending', steps: {}, updatedAt: null, updatedBy: null }
}

async function save(state: Stored, userId: string | null) {
  await db().insert(schema.appSettings).values({ key: KEY, value: state, updatedBy: userId })
    .onConflictDoUpdate({ target: schema.appSettings.key, set: { value: state, updatedBy: userId, updatedAt: new Date() } })
}

export async function onboardingPending(): Promise<boolean> {
  return (await getOnboarding()).status === 'pending'
}

export async function setStep(step: OnboardingStep, status: 'done' | 'skipped', user: { id: string | null, email: string }): Promise<OnboardingState> {
  const cur = await getOnboarding()
  await save({ status: cur.status === 'completed' ? 'completed' : 'pending', steps: { ...cur.steps, [step]: status } }, user.id)
  await audit({ actorUserId: user.id, actorLabel: user.email, action: 'onboarding.step', outcome: 'success', details: { step, status } })
  return getOnboarding()
}

export async function finish(mode: 'completed' | 'dismissed', user: { id: string | null, email: string }): Promise<OnboardingState> {
  const cur = await getOnboarding()
  await save({ status: mode, steps: cur.steps }, user.id)
  await audit({ actorUserId: user.id, actorLabel: user.email, action: mode === 'completed' ? 'onboarding.completed' : 'onboarding.dismissed', outcome: 'success', details: { steps: cur.steps } })
  return getOnboarding()
}

/** Réouvre l'assistant (depuis la page Mise en service). */
export async function reopen(user: { id: string | null, email: string }): Promise<OnboardingState> {
  const cur = await getOnboarding()
  await save({ status: 'pending', steps: cur.steps }, user.id)
  await audit({ actorUserId: user.id, actorLabel: user.email, action: 'onboarding.reopened', outcome: 'success' })
  return getOnboarding()
}

export async function onboardingFacts(): Promise<OnboardingFacts> {
  const e = env()
  const [checks, groups, roles, bindings, members, idps, mappings, channels, servers, endpoints, runners] = await Promise.all([
    security(),
    db().select().from(schema.groups),
    db().select({ id: schema.roles.id, key: schema.roles.key, name: schema.roles.name }).from(schema.roles),
    db().select().from(schema.roleBindings).where(eq(schema.roleBindings.subjectType, 'group')),
    db().select({ groupId: schema.userGroups.groupId, n: count() }).from(schema.userGroups).groupBy(schema.userGroups.groupId),
    db().select().from(schema.identityProviders),
    db().select({ idpId: schema.idpGroupMappings.idpId, n: count() }).from(schema.idpGroupMappings).groupBy(schema.idpGroupMappings.idpId),
    listChannels(),
    db().select().from(schema.portainerServers),
    db().select({ id: schema.serverEndpoints.id, serverId: schema.serverEndpoints.serverId, enabled: schema.serverEndpoints.enabled }).from(schema.serverEndpoints),
    db().select({ endpointId: schema.targetRunners.endpointId, status: schema.targetRunners.status }).from(schema.targetRunners),
  ])
  const adminIds = await globalAdminUserIds()
  const local = adminIds.length
  const localAdmins = adminIds.length ? (await db().select({ kind: schema.users.kind }).from(schema.users).where(inArray(schema.users.id, adminIds))).filter(u => u.kind === 'local').length : 0
  return {
    checks: checks.items,
    groups: groups.map(g => ({
      id: g.id, name: g.name,
      roles: bindings.filter(b => b.subjectId === g.id).map(b => roles.find(r => r.id === b.roleId)?.name ?? '?'),
      members: members.find(m => m.groupId === g.id)?.n ?? 0,
    })),
    roles,
    admins: { total: local, local: localAdmins },
    idps: idps.map(i => ({ id: i.id, key: i.key, name: i.name, kind: i.kind, enabled: i.enabled, mappings: mappings.find(m => m.idpId === i.id)?.n ?? 0, redirectUri: redirectUri(i) })),
    smtp: smtpConfigured(),
    channels: channels.map(c => ({ id: c.id, name: c.name, kind: c.kind, lastStatus: c.lastDelivery?.status ?? null })),
    webhookHosts: e.NOTIFY_WEBHOOK_ALLOWED_HOSTS.split(',').map(h => h.trim()).filter(Boolean),
    servers: servers.map((s) => {
      const eps = endpoints.filter(x => x.serverId === s.id && x.enabled)
      const rs = runners.filter(r => eps.some(x => x.id === r.endpointId))
      return { id: s.id, name: s.name, status: s.status, endpointsEnabled: eps.length, runners: rs.length, runnersOnline: rs.filter(r => r.status === 'online').length }
    }),
    githubApis: e.GITHUB_ALLOWED_API_URLS.split(',').map(x => x.trim()).filter(Boolean),
    appUrl: e.APP_URL,
  }
}

/** Joignabilité des API GitHub autorisées, sans token (limite anonyme affichée). */
export async function checkGithubApis(): Promise<GithubCheck[]> {
  const apis = env().GITHUB_ALLOWED_API_URLS.split(',').map(x => x.trim().replace(/\/+$/, '')).filter(Boolean)
  return Promise.all(apis.map(async (api): Promise<GithubCheck> => {
    try {
      const res = await fetch(`${api}/rate_limit`, { headers: { 'accept': 'application/vnd.github+json', 'user-agent': 'sherpa' }, redirect: 'manual', signal: AbortSignal.timeout(10_000) })
      const remaining = Number(res.headers.get('x-ratelimit-remaining'))
      const limit = Number(res.headers.get('x-ratelimit-limit'))
      const known = { remaining: Number.isFinite(remaining) && res.headers.has('x-ratelimit-remaining') ? remaining : null, limit: Number.isFinite(limit) && res.headers.has('x-ratelimit-limit') ? limit : null }
      if (res.ok) return { api, ok: true, detail: known.limit ? `Joignable · ${known.remaining}/${known.limit} appels anonymes restants cette heure` : 'Joignable', ...known }
      // Une API qui répond (même 404 sur /rate_limit, ex. faux GitHub) est joignable.
      return { api, ok: res.status < 500, detail: `Joignable, réponse ${res.status} sur /rate_limit`, ...known }
    }
    catch (err) {
      const c = err as { name?: string, cause?: { code?: string }, message?: string }
      return { api, ok: false, detail: c.name === 'TimeoutError' ? 'Délai dépassé (pare-feu ou proxy ?)' : `Injoignable : ${c.cause?.code ?? c.message}`, remaining: null, limit: null }
    }
  }))
}
