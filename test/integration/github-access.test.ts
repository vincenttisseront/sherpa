/**
 * Dépôts publics et privés, comme sur github.com : accès anonyme ou par token,
 * dépôt privé « introuvable » sans accès, SAML SSO, limite d'appels anonymes,
 * archive privée par lien à jeton temporaire, sous-module privé dans un dépôt public.
 */
import type { Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { Writable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { accessAdvice, createGithubClient, tokenKind } from '../../server/lib/github'
import { createMockGithub } from '../../scripts/mock-github'

const files = { 'compose.yml': 'services:\n  web:\n    build: .\n', 'Dockerfile': 'FROM scratch\n' }
const PUB_TOKEN_FG = 'github_pat_finegrainedtokenpublic0001'
const PRIV_TOKEN_FG = 'github_pat_finegrainedtokenprivate001'
const CLASSIC_BROAD = 'ghp_classicbroadtoken00000000000001'
const SSO_TOKEN = 'ghp_ssounauthorizedtoken0000000001'

let server: Server
let limited: Server
let api: string
let apiLimited: string

beforeAll(async () => {
  const repos = {
    'acme/public-app': { files, branch: 'main' },
    'acme/private-app': { files, branch: 'main', private: true },
    'acme/secret-lib': { files: { 'x.js': '1' }, private: true },
    'other/private': { files, private: true },
  }
  server = createMockGithub(repos, {
    tokens: {
      [PUB_TOKEN_FG]: { repos: [] },
      [PRIV_TOKEN_FG]: { repos: ['acme/private-app'] },
      [CLASSIC_BROAD]: { scopes: ['repo', 'admin:org', 'delete_repo'] },
      [SSO_TOKEN]: { scopes: ['repo'], ssoUnauthorized: ['acme'] },
    },
  })
  limited = createMockGithub({ 'acme/public-app': { files } }, { anonymousLimit: 2 })
  for (const s of [server, limited]) await new Promise<void>(r => s.listen(0, '127.0.0.1', r))
  api = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  apiLimited = `http://127.0.0.1:${(limited.address() as AddressInfo).port}`
})
afterAll(() => {
  server?.close()
  limited?.close()
})

const gh = () => createGithubClient({ allowedApiUrls: [api, apiLimited], allowHttp: true })
const src = (repository: string, token: string | null = null, apiUrl = api) => ({ apiUrl, repository, token })

async function zipSize(s: ReturnType<typeof src>, sha: string): Promise<number> {
  let n = 0
  await pipeline(await gh().zipball(s, sha), new Writable({ write(c, _e, cb) { n += c.length; cb() } }))
  return n
}

describe('dépôt public', () => {
  it('sans token : dépôt, commit, arbre, fichier et archive', async () => {
    const s = src('acme/public-app')
    const repo = await gh().repository(s)
    expect(repo).toMatchObject({ visibility: 'public', private: false, scopes: null })
    const c = await gh().resolve(s, 'branch', 'main')
    expect((await gh().tree(s, c.sha)).entries.map(e => e.path)).toContain('compose.yml')
    expect(await gh().file(s, c.sha, 'compose.yml', 10_000)).toContain('services')
    expect(await zipSize(s, c.sha)).toBeGreaterThan(100)
  })

  it('avec un token sans accès aux dépôts privés : fonctionne aussi', async () => {
    const s = src('acme/public-app', PUB_TOKEN_FG)
    const c = await gh().resolve(s, 'branch', 'main')
    expect(await zipSize(s, c.sha)).toBeGreaterThan(100)
  })

  it('un token invalide n\'est jamais ignoré, même pour un dépôt public', async () => {
    await expect(gh().repository(src('acme/public-app', 'ghp_invalide'))).rejects.toMatchObject({ kind: 'auth', status: 401 })
  })

  it('limite d\'appels anonymes : message explicite avec l\'heure de réinitialisation', async () => {
    const s = src('acme/public-app', null, apiLimited)
    await gh().repository(s)
    await gh().repository(s)
    const err = await gh().repository(s).catch(e => e)
    expect(err).toMatchObject({ kind: 'rate_limit' })
    expect(err.message).toMatch(/sans token.*60 par heure.*réinitialisation à \d{2}:\d{2}/)
  })
})

describe('dépôt privé', () => {
  it('sans token : introuvable, avec un message qui oriente vers le token', async () => {
    const err = await gh().repository(src('acme/private-app')).catch(e => e)
    expect(err).toMatchObject({ kind: 'not_found', status: 404 })
    expect(err.message).toMatch(/dépôt privé.*token/)
  })

  it('avec un token fine-grained limité à ce dépôt : tout fonctionne, archive par lien pré-signé', async () => {
    const s = src('acme/private-app', PRIV_TOKEN_FG)
    expect(await gh().repository(s)).toMatchObject({ visibility: 'private', private: true, scopes: null })
    const c = await gh().resolve(s, 'branch', 'main')
    expect(await gh().file(s, c.sha, 'Dockerfile', 10_000)).toContain('FROM')
    expect(await zipSize(s, c.sha)).toBeGreaterThan(100)
  })

  it('le même token n\'ouvre pas les autres dépôts privés', async () => {
    const err = await gh().repository(src('acme/secret-lib', PRIV_TOKEN_FG)).catch(e => e)
    expect(err).toMatchObject({ kind: 'not_found' })
    expect(err.message).toMatch(/token sans accès/)
  })

  it('organisation SAML SSO : message dédié avec le lien d\'autorisation', async () => {
    const err = await gh().repository(src('acme/private-app', SSO_TOKEN)).catch(e => e)
    expect(err).toMatchObject({ kind: 'sso', status: 403 })
    expect(err.message).toMatch(/SAML SSO.*https:\/\/github\.example\/orgs\/acme\/sso/)
  })

  it('token classique large : périmètres détectés pour les conseils', async () => {
    const repo = await gh().repository(src('other/private', CLASSIC_BROAD))
    expect(repo.scopes).toEqual(['repo', 'admin:org', 'delete_repo'])
    const advice = accessAdvice(repo.visibility, tokenKind(CLASSIC_BROAD), repo.scopes)
    expect(advice.map(a => a.level)).toContain('warning')
    expect(advice[0]!.message).toMatch(/admin:org, delete_repo/)
  })
})

describe('conseils d\'accès', () => {
  it('nature du token d\'après son préfixe', () => {
    expect([null, 'github_pat_x', 'ghp_x', 'ghs_x', 'gho_x', 'abc'].map(tokenKind)).toEqual(['none', 'fine-grained', 'classic', 'app', 'oauth', 'unknown'])
  })
  it('dépôt public sans token : limite signalée ; token repo sur dépôt public : déconseillé', () => {
    expect(accessAdvice('public', 'none', null)[0]!.message).toMatch(/60 appels/)
    expect(accessAdvice('public', 'classic', ['repo']).some(a => a.level === 'warning' && /fine-grained/.test(a.message))).toBe(true)
    expect(accessAdvice('private', 'fine-grained', null)).toEqual([])
  })
})
