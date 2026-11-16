/**
 * Parcours OIDC complet contre un vrai fournisseur (oidc-provider) :
 * autorisation → connexion → consentement → échange du code (PKCE) →
 * validation de l'ID token → provisionnement et groupes.
 */
import type { Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { databaseAvailable, setupTestDatabase } from '../helpers/db'

const available = await databaseAvailable()

const accounts: Record<string, Record<string, unknown>> = {
  alice: { sub: 'alice', email: 'Alice@Acme.fr', email_verified: true, name: 'Alice Martin', groups: ['/devops', '/autre'] },
  bob: { sub: 'bob', email: 'bob@acme.fr', email_verified: true, name: 'Bob', groups: ['/inconnu'] },
  eve: { sub: 'eve', email: 'eve@acme.fr', email_verified: false, name: 'Eve', groups: ['/devops'] },
  carol: { sub: 'carol', email: 'carol@acme.fr', email_verified: true, name: 'Carol', groups: ['/devops'] },
  mallory: { sub: 'mallory', email: 'mallory@evil.com', email_verified: true, name: 'Mallory', groups: ['/devops'] },
}

describe.skipIf(!available)('connexion OIDC (fournisseur réel en mémoire)', () => {
  let server: Server
  let issuer: string
  let mod: typeof import('../../server/auth/oidc')
  let dbm: typeof import('../../server/db/client')
  let idp: Awaited<ReturnType<typeof createIdp>>
  let devopsGroup: string

  async function createIdp() {
    const { encryptSecret } = await import('../../server/utils/crypto')
    const { envelope, keyId } = encryptSecret('secret-de-test')
    const [s] = await dbm.db().insert(dbm.schema.secrets).values({ purpose: 'oidc_client_secret', envelope, keyId }).returning()
    const [i] = await dbm.db().insert(dbm.schema.identityProviders).values({
      key: 'test-idp', kind: 'keycloak', name: 'Keycloak de test', issuerUrl: issuer, clientId: 'platform', clientSecretId: s!.id,
      scopes: ['openid', 'email', 'profile', 'groups'], groupsClaim: 'groups', requireMappedGroup: true, allowedEmailDomains: ['acme.fr'],
    }).returning()
    return i!
  }

  beforeAll(async () => {
    process.env.APP_URL = 'http://localhost:3999'
    await setupTestDatabase()
    dbm = await import('../../server/db/client')
    mod = await import('../../server/auth/oidc')
    const { default: Provider } = await import('oidc-provider')
    // Port connu d'avance : l'émetteur doit être l'URL réelle du fournisseur.
    const probe = (await import('node:http')).createServer()
    await new Promise<void>(r => probe.listen(0, '127.0.0.1', r))
    const port = (probe.address() as AddressInfo).port
    probe.close()
    issuer = `http://127.0.0.1:${port}`
    const provider = new Provider(issuer, {
      clients: [{ client_id: 'platform', client_secret: 'secret-de-test', redirect_uris: ['http://localhost:3999/api/auth/oidc/test-idp/callback'], grant_types: ['authorization_code'], response_types: ['code'] }],
      claims: { openid: ['sub'], email: ['email', 'email_verified'], profile: ['name'], groups: ['groups'] },
      scopes: ['openid', 'email', 'profile', 'groups'],
      findAccount: async (_ctx: unknown, id: string) => ({ accountId: id, claims: async () => accounts[id] }),
      conformIdTokenClaims: false,
      cookies: { keys: ['cle-de-test'] },
    } as never)
    server = provider.listen(port) as unknown as Server
    await new Promise(r => setTimeout(r, 100))
    idp = await createIdp()
    const [g] = await dbm.db().insert(dbm.schema.groups).values({ name: 'DevOps' }).returning()
    devopsGroup = g!.id
    await dbm.db().insert(dbm.schema.idpGroupMappings).values({ idpId: idp.id, externalGroup: '/devops', groupId: devopsGroup })
    const [creator] = await dbm.db().select().from(dbm.schema.roles).where((await import('drizzle-orm')).eq(dbm.schema.roles.key, 'creator'))
    await dbm.db().insert(dbm.schema.roleBindings).values({ roleId: creator!.id, subjectType: 'group', subjectId: devopsGroup })
  }, 30_000)

  afterAll(async () => {
    server?.close()
    await (await import('../../server/queue/redis')).closeRedis()
    await dbm?.closeDb()
  })

  /** Joue le parcours navigateur : connexion puis consentement ; renvoie l'URL de retour (code + state). */
  async function browserLogin(account: string): Promise<URL> {
    const jar = new Map<string, string>()
    const go = async (url: string, init: RequestInit = {}) => {
      const res = await fetch(url, { ...init, redirect: 'manual', headers: { ...(init.headers ?? {}), cookie: [...jar].map(([k, v]) => `${k}=${v}`).join('; ') } })
      for (const c of res.headers.getSetCookie()) {
        const [kv] = c.split(';')
        const [k, v] = kv!.split('=')
        jar.set(k!, v ?? '')
      }
      return res
    }
    let res = await go(await mod.startLogin(idp, '/projects/42'))
    for (let i = 0; i < 12; i++) {
      const loc = res.headers.get('location')
      if (loc?.startsWith('http://localhost:3999/')) return new URL(loc)
      if (loc) {
        res = await go(new URL(loc, issuer).href)
        continue
      }
      const html = await res.text()
      const action = /action="([^"]+)"/.exec(html)?.[1]
      if (!action) throw new Error(`Page inattendue : ${html.slice(0, 200)}`)
      const body = html.includes('name="login"') ? `prompt=login&login=${account}&password=x` : 'prompt=consent'
      res = await go(new URL(action, issuer).href, { method: 'POST', body, headers: { 'content-type': 'application/x-www-form-urlencoded' } })
    }
    throw new Error('Parcours de connexion trop long')
  }

  it('connecte un utilisateur, le crée et lui attribue les groupes mappés', async () => {
    const { identity, returnTo } = await mod.finishLogin(idp, await browserLogin('alice'))
    expect(identity).toMatchObject({ sub: 'alice', email: 'alice@acme.fr', name: 'Alice Martin', groups: ['/devops', '/autre'] })
    expect(returnTo).toBe('/projects/42')
    const user = await mod.provisionUser(idp, identity)
    expect(user).toMatchObject({ kind: 'sso', email: 'alice@acme.fr', idpSubject: 'alice', status: 'active' })
    const { loadGrants } = await import('../../server/auth/grants')
    const grants = await loadGrants(user.id)
    expect(grants.flatMap(g => g.permissions)).toContain('deployment:execute')
  })

  it('reconnaît l\'utilisateur à la connexion suivante et resynchronise ses groupes', async () => {
    const { identity } = await mod.finishLogin(idp, await browserLogin('alice'))
    const again = await mod.provisionUser(idp, identity)
    const users = await dbm.db().select().from(dbm.schema.users)
    expect(users.filter(u => u.email === 'alice@acme.fr')).toHaveLength(1)
    const lost = await mod.provisionUser(idp, { ...identity, groups: ['/devops'] })
    expect(lost.id).toBe(again.id)
  })

  it('refuse un utilisateur sans groupe mappé', async () => {
    const { identity } = await mod.finishLogin(idp, await browserLogin('bob'))
    await expect(mod.provisionUser(idp, identity)).rejects.toMatchObject({ reason: 'no_group' })
  })

  it('refuse un email non vérifié par le fournisseur', async () => {
    await expect(mod.finishLogin(idp, await browserLogin('eve'))).rejects.toMatchObject({ reason: 'email_unverified' })
  })

  it('refuse un domaine d\'email non autorisé', async () => {
    const { identity } = await mod.finishLogin(idp, await browserLogin('mallory'))
    await expect(mod.provisionUser(idp, identity)).rejects.toMatchObject({ reason: 'domain' })
  })

  it('ne rattache jamais un SSO à un compte local de même email', async () => {
    await dbm.db().insert(dbm.schema.users).values({ email: 'carol@acme.fr', displayName: 'Carol (locale)', kind: 'local', status: 'active', passwordHash: 'x' })
    const { identity } = await mod.finishLogin(idp, await browserLogin('carol'))
    await expect(mod.provisionUser(idp, identity)).rejects.toMatchObject({ reason: 'email_conflict' })
  })

  it('refuse le rejeu d\'un retour déjà utilisé (state à usage unique)', async () => {
    const url = await browserLogin('alice')
    await mod.finishLogin(idp, url)
    await expect(mod.finishLogin(idp, url)).rejects.toMatchObject({ reason: 'state' })
  })

  it('refuse un state forgé', async () => {
    const url = await browserLogin('alice')
    url.searchParams.set('state', 'forge')
    await expect(mod.finishLogin(idp, url)).rejects.toMatchObject({ reason: 'state' })
  })

  it('refuse un code altéré (échange rejeté par le fournisseur)', async () => {
    const url = await browserLogin('alice')
    url.searchParams.set('code', 'code-altere')
    await expect(mod.finishLogin(idp, url)).rejects.toMatchObject({ reason: 'token' })
  })

  it('ne redirige jamais hors de la plateforme après connexion', () => {
    expect(mod.safeReturnTo('/projects')).toBe('/projects')
    for (const bad of ['//evil.com', 'https://evil.com', '/\\evil.com', 'javascript:alert(1)', '/api/auth/logout', null]) expect(mod.safeReturnTo(bad)).toBe('/')
  })
})
