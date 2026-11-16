import { execFile } from 'node:child_process'
import { type Server, createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { promisify } from 'node:util'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
// @ts-expect-error module JavaScript sans types (fichier public servi par la console)
import { parseArgs, resolveAccess } from '../../public/cli/sherpa.mjs'

const run = promisify(execFile)
const TOKEN = `shp_${'a'.repeat(43)}`

describe('arguments et accès', () => {
  it('options, drapeaux, négations et positionnels', () => {
    expect(parseArgs(['deploy', 'shop', '--env', 'production', '--clean', '--no-wait', '--timeout=60'])).toEqual({ flags: { env: 'production', clean: true, wait: false, timeout: '60' }, positional: ['deploy', 'shop'] })
    expect(() => parseArgs(['deploy', '--env'])).toThrow(/Valeur manquante/)
    expect(parseArgs(['-h']).flags.help).toBe(true)
  })
  it('accès : options > environnement > fichier ; refus d\'un jeton ou d\'une adresse invalides', () => {
    expect(resolveAccess({ url: 'https://a/' }, { SHERPA_URL: 'https://b', SHERPA_TOKEN: TOKEN }, {})).toEqual({ url: 'https://a', token: TOKEN })
    expect(resolveAccess({}, {}, { url: 'https://c', token: TOKEN })).toEqual({ url: 'https://c', token: TOKEN })
    expect(() => resolveAccess({}, { SHERPA_TOKEN: TOKEN }, {})).toThrow(/Console inconnue/)
    expect(() => resolveAccess({ url: 'ftp://x' }, { SHERPA_TOKEN: TOKEN }, {})).toThrow(/invalide/)
    expect(() => resolveAccess({ url: 'https://x' }, { SHERPA_TOKEN: 'abc' }, {})).toThrow(/Jeton/)
  })
})

describe('commandes contre une fausse console', () => {
  let server: Server
  let url = ''
  const seen: { method: string, path: string, auth: string | undefined, body: string }[] = []
  let finalStatus = 'HEALTHY'
  let upToDate = false
  beforeAll(async () => {
    server = createServer((req, res) => {
      let body = ''
      req.on('data', c => (body += c))
      req.on('end', () => {
        seen.push({ method: req.method!, path: req.url!, auth: req.headers.authorization, body })
        const json = (status: number, v: unknown) => {
          res.writeHead(status, { 'content-type': 'application/json' })
          res.end(JSON.stringify(v))
        }
        if (req.headers.authorization !== `Bearer ${TOKEN}`) return json(401, { statusMessage: 'Authentification requise' })
        const p = req.url!
        if (p === '/api/auth/me') return json(200, { authenticated: true, user: { email: 'ci@exemple.fr (jeton ci)' }, permissions: ['project:read', 'deployment:execute'] })
        if (p.startsWith('/api/projects?')) return json(200, { items: [{ id: 'p1', slug: 'shop', name: 'Boutique', targetCount: 2, lastStatus: 'HEALTHY' }] })
        if (p === '/api/projects/p1') return json(200, { id: 'p1', slug: 'shop', name: 'Boutique', targets: [{ id: 't-prod', environment: { key: 'production', name: 'Production' }, server: { name: 'srv' }, currentRelease: { number: 3 }, lastDeployment: { status: 'HEALTHY', action: 'deploy' } }, { id: 't-stg', environment: { key: 'staging', name: 'Staging' }, server: { name: 'srv' }, currentRelease: null, lastDeployment: null }] })
        if (p === '/api/targets/t-prod/rebuild' && req.method === 'GET') return json(200, { upToDate, current: { label: 'main @ abc1234' }, latest: { label: 'main @ def5678' } })
        if (p === '/api/targets/t-prod/rebuild' && req.method === 'POST') return json(202, { deploymentId: 'd1' })
        if (p === '/api/targets/t-stg/rebuild') return json(403, { statusMessage: 'Permission insuffisante' })
        if (p === '/api/deployments/d1') return json(200, { id: 'd1', status: finalStatus, error: finalStatus === 'HEALTHY' ? null : 'Healthchecks en échec : web' })
        if (p.startsWith('/api/deployments/d1/logs')) {
          res.writeHead(200, { 'content-type': 'text/plain' })
          return res.end('2026 INFO  [system] Statut : BUILDING\n2026 ERROR [healthcheck/web] injoignable\n')
        }
        json(404, { statusMessage: 'Introuvable' })
      })
    })
    await new Promise<void>(r => server.listen(0, '127.0.0.1', r))
    url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  })
  afterAll(() => server.close())

  const sherpa = (args: string[], env: Record<string, string> = {}) => run('node', ['public/cli/sherpa.mjs', ...args], { env: { PATH: process.env.PATH, SHERPA_URL: url, SHERPA_TOKEN: TOKEN, ...env }, timeout: 30_000 }).then(r => ({ code: 0, ...r }), e => ({ code: e.code as number, stdout: e.stdout as string, stderr: e.stderr as string }))

  it('whoami, projects et status', async () => {
    expect((await sherpa(['whoami'])).stdout).toContain('ci@exemple.fr (jeton ci)')
    expect((await sherpa(['projects'])).stdout).toMatch(/shop\s+Boutique\s+2\s+HEALTHY/)
    const st = await sherpa(['status', 'shop'])
    expect(st.stdout).toMatch(/production\s+#3\s+opérationnel \(deploy\)/)
    expect(st.stdout).toMatch(/staging\s+—/)
    expect(JSON.parse((await sherpa(['status', 'shop', '--env', 'staging', '--json'])).stdout)).toHaveLength(1)
  })

  it('deploy --wait : lancé avec le jeton, attend la fin, code 0', async () => {
    seen.length = 0
    const r = await sherpa(['deploy', 'shop', '--env', 'production', '--wait', '--clean'])
    expect(r.code).toBe(0)
    expect(r.stdout).toContain('main @ abc1234 → main @ def5678')
    expect(r.stdout).toContain(`Déploiement lancé : ${url}/deployments/d1`)
    expect(r.stdout).toContain('Terminé : opérationnel')
    const post = seen.find(s => s.method === 'POST')!
    expect(JSON.parse(post.body)).toEqual({ cleanBuild: true })
    expect(post.auth).toBe(`Bearer ${TOKEN}`)
  }, 30_000)

  it('--env obligatoire quand il y en a plusieurs ; environnement inconnu ; version déjà en service', async () => {
    expect((await sherpa(['deploy', 'shop'])).code).toBe(2)
    expect((await sherpa(['deploy', 'shop', '--env', 'dev'])).stderr).toContain('inconnu')
    upToDate = true
    const r = await sherpa(['deploy', 'shop', '--env', 'production'])
    expect(r.code).toBe(0)
    expect(r.stdout).toContain('déjà en service')
    upToDate = false
  })

  it('échec du déploiement : code 1, cause et logs en erreur', async () => {
    finalStatus = 'ROLLED_BACK'
    const r = await sherpa(['deploy', 'shop', '--env', 'production'])
    finalStatus = 'HEALTHY'
    expect(r.code).toBe(1)
    expect(r.stderr).toContain('retour à la version précédente')
    expect(r.stderr).toContain('Healthchecks en échec : web')
    expect(r.stderr).toContain('injoignable')
  }, 30_000)

  it('droit insuffisant, jeton refusé, console injoignable, projet inconnu', async () => {
    expect((await sherpa(['deploy', 'shop', '--env', 'staging'])).stderr).toContain('Droit insuffisant : Permission insuffisante')
    const bad = await sherpa(['whoami'], { SHERPA_TOKEN: `shp_${'b'.repeat(43)}` })
    expect(bad.code).toBe(1)
    expect(bad.stderr).toContain('Jeton refusé')
    expect((await sherpa(['whoami'], { SHERPA_URL: 'http://127.0.0.1:1' })).stderr).toContain('injoignable')
    expect((await sherpa(['status', 'inconnu'])).stderr).toBeDefined()
    expect((await sherpa(['logs'])).code).toBe(2)
    expect((await sherpa(['nimporte'])).code).toBe(2)
    expect((await sherpa(['logs', 'd1'])).stdout).toContain('Statut : BUILDING')
  })
})
