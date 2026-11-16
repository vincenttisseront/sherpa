import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createGithubClient, downloadHostsFor, parseGitmodules } from '../../server/lib/github'
import { commitOf, createMockGithub } from '../../scripts/mock-github'

const repo = { releases: [{ tag: 'v1.2.0', files: { a: '2' }, body: '## Changements\n- **Breaking** : variable `OLD_URL` renommée en `APP_URL`\n<!-- note interne -->' }, { tag: 'v1.1.0', prerelease: true, files: { a: '1' } }], files: { 'app/compose.yml': 'services: {}\n', 'app/Dockerfile': 'FROM scratch\n', '.gitmodules': '[submodule "libs/ui"]\n\tpath = libs/ui\n\turl = https://github.com/acme/ui.git\n' }, branch: 'main', tag: 'v1.0.0', submodules: { 'libs/ui': { repository: 'acme/ui' } } }
const ui = { files: { 'index.js': 'export {}' } }
let server: Server
let api: string
const token = 'ghp_testtokentesttokentesttoken12'

beforeAll(async () => {
  server = createMockGithub({ 'acme/shop': repo, 'acme/ui': ui }, { token })
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r))
  api = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
})
afterAll(() => server?.close())

const client = () => createGithubClient({ allowedApiUrls: [api], allowHttp: true })
const src = () => ({ apiUrl: api, repository: 'acme/shop', token })

describe('client GitHub : notes de version', () => {
  it('liste les releases avec leur texte, brouillons exclus', async () => {
    const notes = await client().releaseNotes(src(), 10)
    expect(notes.map(n => n.tag)).toEqual(['v1.2.0', 'v1.1.0'])
    expect(notes[0]!.body).toContain('OLD_URL')
    expect(notes[1]!.prerelease).toBe(true)
    expect(notes[1]!.body).toBe('')
  })

  it('refuse un dépôt hors liste d\'API autorisées', async () => {
    await expect(createGithubClient({ allowedApiUrls: ['https://api.github.com'], allowHttp: true }).releaseNotes(src())).rejects.toMatchObject({ kind: 'forbidden_host' })
  })
})

describe('client GitHub', () => {
  it('résout branche, tag annoté et SHA court vers le même commit complet', async () => {
    const sha = commitOf(repo)
    expect((await client().resolve(src(), 'branch', 'main')).sha).toBe(sha)
    expect((await client().resolve(src(), 'tag', 'v1.0.0')).sha).toBe(sha)
    expect((await client().resolve(src(), 'commit', sha.slice(0, 10))).sha).toBe(sha)
  })

  it('liste l\'arbre avec les sous-modules et leur SHA', async () => {
    const t = await client().tree(src(), commitOf(repo))
    expect(t.entries.find(e => e.path === 'libs/ui')).toMatchObject({ type: 'commit', sha: commitOf(ui) })
    expect(t.entries.filter(e => e.type === 'blob').map(e => e.path).sort()).toEqual(['.gitmodules', 'app/Dockerfile', 'app/compose.yml'])
  })

  it('lit un fichier au commit exact et borne sa taille', async () => {
    expect(await client().file(src(), commitOf(repo), 'app/compose.yml', 1000)).toBe('services: {}\n')
    await expect(client().file(src(), commitOf(repo), 'app/compose.yml', 5)).rejects.toThrow(/volumineux/)
  })

  it('télécharge l\'archive en suivant une redirection autorisée', async () => {
    let bytes = 0
    for await (const c of await client().zipball(src(), commitOf(repo))) bytes += c.length
    expect(bytes).toBeGreaterThan(100)
  })

  it('refuse un token invalide, un dépôt inconnu et une API non autorisée', async () => {
    await expect(client().repository({ ...src(), token: 'ghp_mauvaismauvaismauvaismauvais00' })).rejects.toMatchObject({ kind: 'auth' })
    await expect(client().repository({ ...src(), repository: 'acme/absent' })).rejects.toMatchObject({ kind: 'not_found' })
    await expect(client().repository({ ...src(), apiUrl: 'http://169.254.169.254' })).rejects.toMatchObject({ kind: 'forbidden_host' })
  })

  it('ne divulgue pas le token dans les messages d\'erreur', async () => {
    const e = await client().repository({ ...src(), repository: 'acme/absent' }).catch(x => x as Error)
    expect(String((e as Error).message)).not.toContain(token)
  })

  it('refuse HTTP sans autorisation explicite', async () => {
    await expect(createGithubClient({ allowedApiUrls: [api] }).repository(src())).rejects.toMatchObject({ kind: 'forbidden_host' })
  })
})

describe('redirection de téléchargement', () => {
  it('refuse une redirection vers un hôte non autorisé (SSRF)', async () => {
    const evil = createServer((req, res) => {
      if (req.url?.includes('/zipball/')) {
        res.writeHead(302, { location: 'http://169.254.169.254/latest/meta-data/' })
        return res.end()
      }
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end('{}')
    })
    await new Promise<void>(r => evil.listen(0, '127.0.0.1', r))
    const evilApi = `http://127.0.0.1:${(evil.address() as AddressInfo).port}`
    const c = createGithubClient({ allowedApiUrls: [evilApi], allowHttp: true })
    await expect(c.zipball({ apiUrl: evilApi, repository: 'a/b', token: null }, 'a'.repeat(40))).rejects.toMatchObject({ kind: 'forbidden_host' })
    evil.close()
  })

  it('associe codeload et le stockage des releases à github.com, et l\'hôte lui-même pour GitHub Enterprise', () => {
    expect(downloadHostsFor('https://api.github.com')).toEqual(['api.github.com', 'codeload.github.com', 'objects.githubusercontent.com', 'release-assets.githubusercontent.com', 'github-releases.githubusercontent.com'])
    expect(downloadHostsFor('https://api.github.com')).not.toContain('evil.example.com')
    expect(downloadHostsFor('https://ghe.interne/api/v3')).toEqual(['ghe.interne'])
  })
})

describe('.gitmodules', () => {
  it('identifie les sous-modules GitHub et rejette les autres hôtes', () => {
    const r = parseGitmodules('[submodule "a"]\n path = libs/a\n url = https://github.com/acme/a.git\n[submodule "b"]\n path = libs/b\n url = git@github.com:acme/b\n[submodule "c"]\n path = libs/c\n url = https://gitlab.com/x/c.git\n', 'https://api.github.com')
    expect(r.map(x => [x.path, x.repository])).toEqual([['libs/a', 'acme/a'], ['libs/b', 'acme/b'], ['libs/c', null]])
  })
})
