/**
 * Connexion SSO OIDC (§15) : Keycloak, Okta ou tout fournisseur OpenID Connect.
 *
 * - code d'autorisation + PKCE (S256), state à usage unique (Redis, 10 min), nonce ;
 * - ID token validé par openid-client (signature, émetteur, audience, expiration, nonce) ;
 * - email vérifié exigé, domaines d'email éventuellement restreints ;
 * - groupes de l'IdP → groupes internes via les mappings ; sans groupe mappé,
 *   l'accès est refusé (sauf si le fournisseur l'autorise explicitement) ;
 * - jamais de rattachement automatique à un compte local de même email.
 */
import { eq, inArray, and, sql } from 'drizzle-orm'
import * as oidc from 'openid-client'
import { db, schema } from '../db/client'
import { redis } from '../queue/redis'
import { decryptSecret } from '../utils/crypto'
import { env } from '../utils/env'

export type IdpRow = typeof schema.identityProviders.$inferSelect

export class OidcLoginError extends Error {
  constructor(message: string, public readonly reason: string) {
    super(message)
    this.name = 'OidcLoginError'
  }
}

const configs = new Map<string, { config: oidc.Configuration, at: number }>()
const CONFIG_TTL_MS = 10 * 60_000

export function redirectUri(idp: Pick<IdpRow, 'key'>): string {
  return `${env().APP_URL}/api/auth/oidc/${idp.key}/callback`
}

/** Configuration OIDC (découverte), mise en cache 10 min. HTTP autorisé hors production uniquement. */
export async function oidcConfig(idp: IdpRow): Promise<oidc.Configuration> {
  const cached = configs.get(idp.id)
  if (cached && Date.now() - cached.at < CONFIG_TTL_MS) return cached.config
  let secret: string | undefined
  if (idp.clientSecretId) {
    const [s] = await db().select({ envelope: schema.secrets.envelope }).from(schema.secrets).where(eq(schema.secrets.id, idp.clientSecretId))
    if (s) secret = decryptSecret(s.envelope)
  }
  const insecure = env().NODE_ENV !== 'production' && idp.issuerUrl.startsWith('http:')
  const config = await oidc.discovery(new URL(idp.issuerUrl), idp.clientId, secret, undefined, {
    ...(insecure ? { execute: [oidc.allowInsecureRequests] } : {}),
    timeout: 10,
  })
  configs.set(idp.id, { config, at: Date.now() })
  return config
}

export function forgetConfig(idpId: string) {
  configs.delete(idpId)
}

/** Chemin de retour après connexion : uniquement un chemin local (pas de redirection ouverte). */
export function safeReturnTo(raw: unknown): string {
  return typeof raw === 'string' && /^\/(?!\/)[\w\-./?=&%#]*$/.test(raw) && !raw.startsWith('/api/') ? raw : '/'
}

export async function startLogin(idp: IdpRow, returnTo: string): Promise<string> {
  const config = await oidcConfig(idp)
  const verifier = oidc.randomPKCECodeVerifier()
  const state = oidc.randomState()
  const nonce = oidc.randomNonce()
  await redis().set(`oidc:state:${state}`, JSON.stringify({ idpId: idp.id, verifier, nonce, returnTo: safeReturnTo(returnTo) }), 'EX', 600)
  return oidc.buildAuthorizationUrl(config, {
    redirect_uri: redirectUri(idp),
    scope: idp.scopes.join(' '),
    code_challenge: await oidc.calculatePKCECodeChallenge(verifier),
    code_challenge_method: 'S256',
    state,
    nonce,
  }).href
}

export interface OidcIdentity {
  sub: string
  email: string
  name: string
  groups: string[]
}

/** Échange du code et validation complète ; renvoie l'identité et le chemin de retour. */
export async function finishLogin(idp: IdpRow, callbackUrl: URL): Promise<{ identity: OidcIdentity, returnTo: string }> {
  const state = callbackUrl.searchParams.get('state') ?? ''
  if (callbackUrl.searchParams.get('error')) throw new OidcLoginError(`Le fournisseur a refusé la connexion : ${callbackUrl.searchParams.get('error_description') ?? callbackUrl.searchParams.get('error')}`, 'idp_error')
  // getdel : le state ne peut servir qu'une fois (anti-rejeu).
  const raw = state ? await redis().getdel(`oidc:state:${state}`) : null
  if (!raw) throw new OidcLoginError('Session de connexion expirée ou déjà utilisée : recommencer', 'state')
  const saved = JSON.parse(raw) as { idpId: string, verifier: string, nonce: string, returnTo: string }
  if (saved.idpId !== idp.id) throw new OidcLoginError('Fournisseur inattendu pour cette connexion', 'state')

  const config = await oidcConfig(idp)
  let tokens: Awaited<ReturnType<typeof oidc.authorizationCodeGrant>>
  try {
    tokens = await oidc.authorizationCodeGrant(config, callbackUrl, { pkceCodeVerifier: saved.verifier, expectedState: state, expectedNonce: saved.nonce, idTokenExpected: true })
  }
  catch (err) {
    throw new OidcLoginError(`Validation de la connexion impossible : ${(err as Error).message}`, 'token')
  }
  const claims = tokens.claims()!
  let groupsRaw: unknown = claims[idp.groupsClaim]
  let email = claims.email as string | undefined
  let emailVerified = claims.email_verified as boolean | undefined
  let name = (claims.name ?? claims.preferred_username) as string | undefined
  if (groupsRaw === undefined || !email) {
    // Certains fournisseurs ne placent groupes ou email que dans userinfo.
    const info = await oidc.fetchUserInfo(config, tokens.access_token, claims.sub)
    groupsRaw ??= info[idp.groupsClaim]
    email ??= info.email
    emailVerified ??= info.email_verified
    name ??= info.name ?? info.preferred_username
  }
  if (!email) throw new OidcLoginError('Le fournisseur n\'a pas transmis d\'email', 'email')
  if (emailVerified === false) throw new OidcLoginError('Email non vérifié chez le fournisseur', 'email_unverified')
  const groups = Array.isArray(groupsRaw) ? groupsRaw.filter((g): g is string => typeof g === 'string') : typeof groupsRaw === 'string' ? [groupsRaw] : []
  return { identity: { sub: claims.sub, email: email.toLowerCase(), name: name ?? email, groups }, returnTo: saved.returnTo }
}

/**
 * Trouve ou crée l'utilisateur SSO et synchronise ses groupes issus de l'IdP.
 * Lève OidcLoginError si l'accès doit être refusé.
 */
export async function provisionUser(idp: IdpRow, id: OidcIdentity): Promise<typeof schema.users.$inferSelect> {
  const domain = id.email.split('@')[1] ?? ''
  if (idp.allowedEmailDomains.length && !idp.allowedEmailDomains.includes(domain)) throw new OidcLoginError(`Domaine ${domain} non autorisé pour ce fournisseur`, 'domain')

  const mappings = id.groups.length
    ? await db().select().from(schema.idpGroupMappings).where(and(eq(schema.idpGroupMappings.idpId, idp.id), inArray(schema.idpGroupMappings.externalGroup, id.groups)))
    : []
  const groupIds = [...new Set(mappings.map(m => m.groupId))]
  if (idp.requireMappedGroup && groupIds.length === 0) throw new OidcLoginError('Aucun de vos groupes ne donne accès à la plateforme : contacter un administrateur', 'no_group')

  return db().transaction(async (tx) => {
    let [user] = await tx.select().from(schema.users).where(and(eq(schema.users.idpId, idp.id), eq(schema.users.idpSubject, id.sub)))
    if (!user) {
      const [sameEmail] = await tx.select().from(schema.users).where(sql`lower(${schema.users.email}) = ${id.email}`)
      // Pas de rattachement automatique : un compte existant (local, externe ou autre IdP) ne doit pas être pris par un SSO.
      if (sameEmail) throw new OidcLoginError('Un compte existe déjà avec cet email : un administrateur doit le rattacher', 'email_conflict')
      ;[user] = await tx.insert(schema.users).values({ email: id.email, displayName: id.name, kind: 'sso', status: 'active', idpId: idp.id, idpSubject: id.sub }).returning()
    }
    if (user!.status !== 'active') throw new OidcLoginError('Compte suspendu ou désactivé', 'status')
    if (user!.expiresAt && user!.expiresAt.getTime() <= Date.now()) throw new OidcLoginError('Compte expiré', 'expired')
    await tx.update(schema.users).set({ displayName: id.name, email: id.email, lastLoginAt: new Date() }).where(eq(schema.users.id, user!.id))
    // Groupes issus de l'IdP : remplacés à chaque connexion ; les groupes attribués à la main sont conservés.
    await tx.delete(schema.userGroups).where(and(eq(schema.userGroups.userId, user!.id), eq(schema.userGroups.fromIdp, true)))
    if (groupIds.length) await tx.insert(schema.userGroups).values(groupIds.map(groupId => ({ userId: user!.id, groupId, fromIdp: true }))).onConflictDoNothing()
    return user!
  })
}

/** URL de déconnexion côté fournisseur (RP-initiated logout), si le fournisseur la propose. */
export async function endSessionUrl(idp: IdpRow): Promise<string | null> {
  try {
    const config = await oidcConfig(idp)
    if (!config.serverMetadata().end_session_endpoint) return null
    return oidc.buildEndSessionUrl(config, { post_logout_redirect_uri: `${env().APP_URL}/login`, client_id: idp.clientId }).href
  }
  catch {
    return null
  }
}
