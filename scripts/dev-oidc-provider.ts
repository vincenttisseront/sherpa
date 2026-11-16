/**
 * Fournisseur OIDC de développement (équivalent d'un Keycloak local) :
 *   npx tsx scripts/dev-oidc-provider.ts
 * Émetteur : http://oidc.localhost:18400 — client « sherpa »,
 * secret dans .data/oidc-dev/client-secret. Comptes de test (mot de passe
 * quelconque, écran de connexion de développement) :
 *   alice → groupe /devops ; bob → groupe /lecture ; zoe → aucun groupe.
 * DÉVELOPPEMENT UNIQUEMENT.
 */
import { randomBytes } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import Provider from 'oidc-provider'

const port = Number(process.env.OIDC_DEV_PORT ?? 18400)
const issuer = process.env.OIDC_DEV_ISSUER ?? `http://oidc.localhost:${port}`
const appUrl = process.env.APP_URL ?? 'http://localhost:3100'
mkdirSync('.data/oidc-dev', { recursive: true, mode: 0o700 })
const secretFile = '.data/oidc-dev/client-secret'
if (!existsSync(secretFile)) writeFileSync(secretFile, randomBytes(24).toString('base64url'), { mode: 0o600 })
const secret = readFileSync(secretFile, 'utf8').trim()

const accounts: Record<string, Record<string, unknown>> = {
  alice: { sub: 'alice', email: 'alice@acme.test', email_verified: true, name: 'Alice (DevOps)', groups: ['/devops'] },
  bob: { sub: 'bob', email: 'bob@acme.test', email_verified: true, name: 'Bob (lecture)', groups: ['/lecture'] },
  zoe: { sub: 'zoe', email: 'zoe@acme.test', email_verified: true, name: 'Zoé (sans groupe)', groups: [] },
}

const provider = new Provider(issuer, {
  clients: [{ client_id: 'sherpa', client_secret: secret, redirect_uris: [`${appUrl}/api/auth/oidc/keycloak-dev/callback`], post_logout_redirect_uris: [`${appUrl}/login`], grant_types: ['authorization_code'], response_types: ['code'] }],
  claims: { openid: ['sub'], email: ['email', 'email_verified'], profile: ['name'], groups: ['groups'] },
  scopes: ['openid', 'email', 'profile', 'groups'],
  findAccount: async (_ctx: unknown, id: string) => (accounts[id] ? { accountId: id, claims: async () => accounts[id] } : undefined),
  conformIdTokenClaims: false,
  cookies: { keys: [randomBytes(16).toString('hex')] },
} as never)
provider.listen(port, () => console.info(`OIDC de dev : ${issuer} (comptes : ${Object.keys(accounts).join(', ')})`))
