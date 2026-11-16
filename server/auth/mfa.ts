/**
 * Double authentification des comptes locaux et externes (les comptes SSO s'appuient sur leur fournisseur) :
 * - TOTP (application d'authentification) avec codes de secours à usage unique ;
 * - passkeys WebAuthn, second facteur ou connexion sans mot de passe (vérification de l'utilisateur exigée) ;
 * - défi de connexion court (Redis) entre le mot de passe et l'ouverture de session ;
 * - politique : obligatoire pour personne, les administrateurs ou tous ; tant que le compte n'a pas de facteur,
 *   la session est limitée à la page du compte (sessions.mfa_pending).
 */
import { createHash, randomBytes } from 'node:crypto'
import { generateAuthenticationOptions, generateRegistrationOptions, verifyAuthenticationResponse, verifyRegistrationResponse } from '@simplewebauthn/server'
import type { AuthenticationResponseJSON, AuthenticatorTransport, RegistrationResponseJSON } from '@simplewebauthn/server'
import { and, asc, count, eq, isNull } from 'drizzle-orm'
import type { H3Event } from 'h3'
import { createError, getRequestHeader } from 'h3'
import QRCode from 'qrcode'
import { db, schema } from '../db/client'
import { generateRecoveryCodes, generateTotpSecret, normalizeRecovery, otpauthUrl, verifyTotp } from '../lib/totp'
import { redis } from '../queue/redis'
import { decryptSecret, encryptSecret } from '../utils/crypto'
import { env } from '../utils/env'
import { loadGrants } from './grants'

export type MfaPolicy = 'off' | 'admins' | 'all'
const POLICY_KEY = 'mfa-policy'
const ADMIN_PERMISSIONS = ['user:manage', 'group:manage', 'role:manage', 'policy:manage', 'server:manage', 'audit:read']
const CHALLENGE_TTL_S = 300
const MAX_ATTEMPTS = 5
const sha = (s: string) => createHash('sha256').update(s).digest('hex')

export interface MfaStatus {
  totp: boolean
  recoveryCodesLeft: number
  passkeys: { id: string, name: string, backedUp: boolean, createdAt: string, lastUsedAt: string | null }[]
}
export const hasMfa = (s: MfaStatus) => s.totp || s.passkeys.length > 0

export async function mfaStatus(userId: string): Promise<MfaStatus> {
  const [totp] = await db().select({ at: schema.userTotp.confirmedAt }).from(schema.userTotp).where(eq(schema.userTotp.userId, userId))
  const [left] = await db().select({ n: count() }).from(schema.mfaRecoveryCodes).where(and(eq(schema.mfaRecoveryCodes.userId, userId), isNull(schema.mfaRecoveryCodes.usedAt)))
  const keys = await db().select().from(schema.userPasskeys).where(eq(schema.userPasskeys.userId, userId)).orderBy(asc(schema.userPasskeys.createdAt))
  return {
    totp: !!totp?.at,
    recoveryCodesLeft: left?.n ?? 0,
    passkeys: keys.map(k => ({ id: k.id, name: k.name, backedUp: k.backedUp, createdAt: k.createdAt.toISOString(), lastUsedAt: k.lastUsedAt?.toISOString() ?? null })),
  }
}

// --- Politique ---

export async function getMfaPolicy(): Promise<MfaPolicy> {
  const [row] = await db().select().from(schema.appSettings).where(eq(schema.appSettings.key, POLICY_KEY))
  const v = (row?.value as { required?: string } | undefined)?.required
  return v === 'admins' || v === 'all' ? v : 'off'
}

export async function setMfaPolicy(required: MfaPolicy, userId: string | null): Promise<void> {
  await db().insert(schema.appSettings).values({ key: POLICY_KEY, value: { required }, updatedBy: userId })
    .onConflictDoUpdate({ target: schema.appSettings.key, set: { value: { required }, updatedBy: userId, updatedAt: new Date() } })
  // Sessions ouvertes : exigence recalculée pour chaque compte concerné.
  const users = await db().selectDistinct({ id: schema.sessions.userId }).from(schema.sessions).where(isNull(schema.sessions.revokedAt))
  for (const u of users) await refreshMfaPending(u.id)
}

/** Le compte doit-il avoir un second facteur selon la politique ? Jamais pour un compte SSO. */
export async function mfaRequiredFor(user: { id: string, kind: string }, policy?: MfaPolicy): Promise<boolean> {
  if (user.kind === 'sso' || user.kind === 'dev') return false
  const p = policy ?? await getMfaPolicy()
  if (p === 'off') return false
  if (p === 'all') return true
  return (await loadGrants(user.id)).some(g => g.permissions.some(x => ADMIN_PERMISSIONS.includes(x)))
}

/** Marque (ou libère) les sessions du compte : limitées au compte tant que la politique l'exige sans facteur configuré. */
export async function refreshMfaPending(userId: string): Promise<void> {
  const [u] = await db().select({ id: schema.users.id, kind: schema.users.kind }).from(schema.users).where(eq(schema.users.id, userId))
  if (!u) return
  const pending = (await mfaRequiredFor(u)) && !hasMfa(await mfaStatus(userId))
  await db().update(schema.sessions).set({ mfaPending: pending }).where(and(eq(schema.sessions.userId, userId), isNull(schema.sessions.revokedAt)))
}

// --- Défi de connexion (entre le mot de passe et la session) ---

interface LoginChallenge { userId: string, attempts: number, webauthn?: string }
const challengeKey = (token: string) => `mfa:login:${sha(token)}`

export async function createLoginChallenge(userId: string): Promise<string> {
  const token = randomBytes(24).toString('base64url')
  await redis().set(challengeKey(token), JSON.stringify({ userId, attempts: 0 } satisfies LoginChallenge), 'EX', CHALLENGE_TTL_S)
  return token
}

async function readChallenge(token: string): Promise<LoginChallenge | null> {
  const raw = token.length > 100 ? null : await redis().get(challengeKey(token))
  return raw ? JSON.parse(raw) as LoginChallenge : null
}
async function saveChallenge(token: string, c: LoginChallenge) {
  const ttl = await redis().ttl(challengeKey(token))
  if (ttl > 0) await redis().set(challengeKey(token), JSON.stringify(c), 'EX', ttl)
}
export const dropLoginChallenge = (token: string) => redis().del(challengeKey(token))

/** Défi encore valide : refus après 5 échecs (le défi est détruit : retour au mot de passe). */
export async function useChallenge(token: string): Promise<{ userId: string, fail: () => Promise<void>, challenge: LoginChallenge }> {
  const c = await readChallenge(token)
  if (!c) throw createError({ statusCode: 401, statusMessage: 'Vérification expirée : se reconnecter avec le mot de passe' })
  return {
    userId: c.userId,
    challenge: c,
    fail: async () => {
      c.attempts++
      if (c.attempts >= MAX_ATTEMPTS) await dropLoginChallenge(token)
      else await saveChallenge(token, c)
    },
  }
}

// --- TOTP ---

export async function startTotpSetup(userId: string, account: string): Promise<{ secret: string, otpauth: string, qrSvg: string }> {
  const [cur] = await db().select().from(schema.userTotp).where(eq(schema.userTotp.userId, userId))
  if (cur?.confirmedAt) throw createError({ statusCode: 409, statusMessage: 'L\'application d\'authentification est déjà activée : la désactiver d\'abord' })
  const secret = generateTotpSecret()
  const { envelope, keyId } = encryptSecret(secret)
  await db().transaction(async (tx) => {
    const [sec] = await tx.insert(schema.secrets).values({ purpose: 'totp', envelope, keyId }).returning({ id: schema.secrets.id })
    if (cur) {
      await tx.update(schema.userTotp).set({ secretId: sec!.id, createdAt: new Date() }).where(eq(schema.userTotp.userId, userId))
      await tx.delete(schema.secrets).where(eq(schema.secrets.id, cur.secretId))
    }
    else await tx.insert(schema.userTotp).values({ userId, secretId: sec!.id })
  })
  const otpauth = otpauthUrl(secret, account)
  return { secret, otpauth, qrSvg: await QRCode.toString(otpauth, { type: 'svg', margin: 1, errorCorrectionLevel: 'M' }) }
}

async function totpSecretOf(userId: string): Promise<{ secret: string, confirmed: boolean, lastStep: number | null } | null> {
  const [row] = await db().select({ at: schema.userTotp.confirmedAt, last: schema.userTotp.lastStep, envelope: schema.secrets.envelope }).from(schema.userTotp)
    .innerJoin(schema.secrets, eq(schema.secrets.id, schema.userTotp.secretId)).where(eq(schema.userTotp.userId, userId))
  return row ? { secret: decryptSecret(row.envelope), confirmed: !!row.at, lastStep: row.last } : null
}

/** Active le TOTP après un premier code correct ; renvoie les codes de secours si le compte n'en a pas encore. */
export async function confirmTotp(userId: string, code: string): Promise<{ recoveryCodes: string[] | null }> {
  const t = await totpSecretOf(userId)
  if (!t || t.confirmed) throw createError({ statusCode: 409, statusMessage: 'Aucune configuration en cours' })
  const step = verifyTotp(t.secret, code, Date.now(), null)
  if (step === null) throw createError({ statusCode: 422, statusMessage: 'Code incorrect : vérifier l\'heure de l\'appareil et réessayer', data: { errors: { code: 'Code incorrect' } } })
  await db().update(schema.userTotp).set({ confirmedAt: new Date(), lastStep: step }).where(eq(schema.userTotp.userId, userId))
  const status = await mfaStatus(userId)
  const recoveryCodes = status.recoveryCodesLeft === 0 ? await regenerateRecoveryCodes(userId) : null
  await refreshMfaPending(userId)
  return { recoveryCodes }
}

/** Code TOTP d'un compte : atomique (un même code ne passe qu'une fois, même en parallèle). */
export async function verifyTotpLogin(userId: string, code: string): Promise<boolean> {
  const t = await totpSecretOf(userId)
  if (!t?.confirmed) return false
  const step = verifyTotp(t.secret, code, Date.now(), t.lastStep)
  if (step === null) return false
  const upd = await db().update(schema.userTotp).set({ lastStep: step }).where(and(eq(schema.userTotp.userId, userId), t.lastStep === null ? isNull(schema.userTotp.lastStep) : eq(schema.userTotp.lastStep, t.lastStep))).returning({ id: schema.userTotp.userId })
  return upd.length > 0
}

export async function disableTotp(userId: string): Promise<void> {
  const [cur] = await db().select().from(schema.userTotp).where(eq(schema.userTotp.userId, userId))
  if (!cur) return
  await db().transaction(async (tx) => {
    await tx.delete(schema.userTotp).where(eq(schema.userTotp.userId, userId))
    await tx.delete(schema.secrets).where(eq(schema.secrets.id, cur.secretId))
  })
  // Sans passkey, plus de facteur : les codes de secours n'ont plus d'objet.
  if (!(await mfaStatus(userId)).passkeys.length) await db().delete(schema.mfaRecoveryCodes).where(eq(schema.mfaRecoveryCodes.userId, userId))
  await refreshMfaPending(userId)
}

// --- Codes de secours ---

export async function regenerateRecoveryCodes(userId: string): Promise<string[]> {
  const codes = generateRecoveryCodes()
  await db().transaction(async (tx) => {
    await tx.delete(schema.mfaRecoveryCodes).where(eq(schema.mfaRecoveryCodes.userId, userId))
    await tx.insert(schema.mfaRecoveryCodes).values(codes.map(c => ({ userId, codeHash: sha(normalizeRecovery(c)) })))
  })
  return codes
}

/** Consomme un code de secours (usage unique) ; renvoie le nombre de codes restants, ou null si refusé. */
export async function consumeRecoveryCode(userId: string, code: string): Promise<number | null> {
  const used = await db().update(schema.mfaRecoveryCodes).set({ usedAt: new Date() })
    .where(and(eq(schema.mfaRecoveryCodes.userId, userId), eq(schema.mfaRecoveryCodes.codeHash, sha(normalizeRecovery(code))), isNull(schema.mfaRecoveryCodes.usedAt)))
    .returning({ id: schema.mfaRecoveryCodes.id })
  if (!used.length) return null
  return (await mfaStatus(userId)).recoveryCodesLeft
}

// --- Passkeys (WebAuthn) ---

/** Origine et domaine de confiance (rpID) : ceux de la requête si connus de la console, sinon APP_URL. */
export function relyingParty(event: H3Event): { origin: string, rpID: string } {
  const app = new URL(env().APP_URL)
  const origin = getRequestHeader(event, 'origin')
  const host = getRequestHeader(event, 'host')
  const known = new Set([app.origin, ...(host ? [`http://${host}`, `https://${host}`] : [])])
  const o = origin && known.has(origin) ? new URL(origin) : app
  return { origin: o.origin, rpID: o.hostname }
}

const b64 = (u: Uint8Array) => Buffer.from(u).toString('base64url')
const unb64 = (s: string) => new Uint8Array(Buffer.from(s, 'base64url'))

/** Options WebAuthn en JSON : type volontairement large (leur type exact fait dépasser la profondeur d'instanciation du typage des routes). */
export type WebauthnOptions = Record<string, unknown> & { challenge: string }

export async function passkeyRegistrationOptions(event: H3Event, user: { id: string, email: string, displayName: string }): Promise<WebauthnOptions> {
  const { rpID } = relyingParty(event)
  const existing = await db().select({ id: schema.userPasskeys.credentialId, transports: schema.userPasskeys.transports }).from(schema.userPasskeys).where(eq(schema.userPasskeys.userId, user.id))
  const options = await generateRegistrationOptions({
    rpName: 'Sherpa', rpID, userName: user.email, userDisplayName: user.displayName, userID: new Uint8Array(Buffer.from(user.id.replace(/-/g, ''), 'hex')),
    attestationType: 'none', timeout: 120_000,
    excludeCredentials: existing.map(k => ({ id: k.id, transports: k.transports as AuthenticatorTransport[] })),
    // Passkey « découvrable » avec vérification de l'utilisateur : utilisable seule (sans mot de passe) et comme second facteur.
    authenticatorSelection: { residentKey: 'required', userVerification: 'required' },
  })
  await redis().set(`mfa:reg:${user.id}`, options.challenge, 'EX', CHALLENGE_TTL_S)
  return options as unknown as WebauthnOptions
}

export async function passkeyRegister(event: H3Event, userId: string, name: string, response: RegistrationResponseJSON): Promise<void> {
  const expectedChallenge = await redis().get(`mfa:reg:${userId}`)
  if (!expectedChallenge) throw createError({ statusCode: 422, statusMessage: 'Enregistrement expiré : recommencer' })
  const { origin, rpID } = relyingParty(event)
  let verification
  try {
    verification = await verifyRegistrationResponse({ response, expectedChallenge, expectedOrigin: origin, expectedRPID: rpID, requireUserVerification: true })
  }
  catch (err) {
    throw createError({ statusCode: 422, statusMessage: `Passkey refusée : ${(err as Error).message.slice(0, 160)}` })
  }
  if (!verification.verified || !verification.registrationInfo) throw createError({ statusCode: 422, statusMessage: 'Passkey non vérifiée' })
  await redis().del(`mfa:reg:${userId}`)
  const { credential, credentialBackedUp } = verification.registrationInfo
  try {
    await db().insert(schema.userPasskeys).values({ userId, credentialId: credential.id, publicKey: b64(credential.publicKey), counter: credential.counter, transports: credential.transports ?? [], name, backedUp: credentialBackedUp })
  }
  catch (err) {
    if ((err as { code?: string }).code === '23505') throw createError({ statusCode: 409, statusMessage: 'Cette passkey est déjà enregistrée' })
    throw err
  }
  await refreshMfaPending(userId)
}

/** Options d'authentification : limitées aux passkeys d'un compte (second facteur), ou ouvertes (connexion sans mot de passe). */
export async function passkeyAuthOptions(event: H3Event, userId: string | null): Promise<WebauthnOptions> {
  const { rpID } = relyingParty(event)
  const keys = userId ? await db().select({ id: schema.userPasskeys.credentialId, transports: schema.userPasskeys.transports }).from(schema.userPasskeys).where(eq(schema.userPasskeys.userId, userId)) : []
  const options = await generateAuthenticationOptions({ rpID, userVerification: 'required', timeout: 120_000, allowCredentials: keys.map(k => ({ id: k.id, transports: k.transports as AuthenticatorTransport[] })) })
  return options as unknown as WebauthnOptions
}

/** Vérifie une assertion ; renvoie le compte propriétaire de la passkey (qui doit être `expectedUserId` s'il est donné). */
export async function passkeyAuthVerify(event: H3Event, challenge: string, response: AuthenticationResponseJSON, expectedUserId: string | null): Promise<{ userId: string, passkeyId: string } | null> {
  const [key] = await db().select().from(schema.userPasskeys).where(eq(schema.userPasskeys.credentialId, response.id))
  if (!key || (expectedUserId && key.userId !== expectedUserId)) return null
  const { origin, rpID } = relyingParty(event)
  try {
    const v = await verifyAuthenticationResponse({
      response, expectedChallenge: challenge, expectedOrigin: origin, expectedRPID: rpID, requireUserVerification: true,
      credential: { id: key.credentialId, publicKey: unb64(key.publicKey), counter: key.counter, transports: key.transports as AuthenticatorTransport[] },
    })
    if (!v.verified) return null
    await db().update(schema.userPasskeys).set({ counter: v.authenticationInfo.newCounter, lastUsedAt: new Date() }).where(eq(schema.userPasskeys.id, key.id))
    return { userId: key.userId, passkeyId: key.id }
  }
  catch {
    return null
  }
}

/** Challenge WebAuthn mémorisé côté serveur (connexion : lié au défi ou à un identifiant éphémère). */
export const storeWebauthnChallenge = (key: string, challenge: string) => redis().set(`mfa:wa:${sha(key)}`, challenge, 'EX', CHALLENGE_TTL_S)
export async function takeWebauthnChallenge(key: string): Promise<string | null> {
  const k = `mfa:wa:${sha(key)}`
  const v = await redis().get(k)
  if (v) await redis().del(k)
  return v
}

export async function deletePasskey(userId: string, id: string): Promise<boolean> {
  const del = await db().delete(schema.userPasskeys).where(and(eq(schema.userPasskeys.id, id), eq(schema.userPasskeys.userId, userId))).returning({ id: schema.userPasskeys.id })
  if (!del.length) return false
  const s = await mfaStatus(userId)
  if (!s.totp && !s.passkeys.length) await db().delete(schema.mfaRecoveryCodes).where(eq(schema.mfaRecoveryCodes.userId, userId))
  await refreshMfaPending(userId)
  return true
}

/** Réinitialisation par un administrateur : tous les facteurs sont retirés (le compte doit se reconfigurer). */
export async function resetMfa(userId: string): Promise<void> {
  await disableTotp(userId)
  await db().delete(schema.userPasskeys).where(eq(schema.userPasskeys.userId, userId))
  await db().delete(schema.mfaRecoveryCodes).where(eq(schema.mfaRecoveryCodes.userId, userId))
  await refreshMfaPending(userId)
}
