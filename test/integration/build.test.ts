/**
 * Build Docker réel via le Runner (socket Docker local). Sauté si aucun
 * moteur Docker n'est joignable. Les images utilisent FROM scratch : aucun
 * téléchargement nécessaire.
 */
import { existsSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { extract } from 'tar-stream'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { contextTar, createDockerClient, isIgnored, parseDockerignore } from '../../runner/docker'
import type { RunnerLogLine } from '../../server/adapters/runner/types'
import { startTestRunner, tempBase } from '../helpers/runner'

const SOCKET = process.env.DOCKER_SOCKET ?? '/var/run/docker.sock'
const dockerAvailable = existsSync(SOCKET) && await createDockerClient(SOCKET).ping()
const ctx = { requestId: 'build-it', actor: 'vitest' }
const tag = (n: string) => `platform/it-${n}:t-${process.pid}`

describe('.dockerignore', () => {
  it('applique exclusions et négations', () => {
    const rules = parseDockerignore('# commentaire\nnode_modules\n*.log\nsecrets/\n!keep.log\n')
    expect(isIgnored('node_modules/a/b.js', rules)).toBe(true)
    expect(isIgnored('app.log', rules)).toBe(true)
    expect(isIgnored('keep.log', rules)).toBe(false)
    expect(isIgnored('secrets/key.pem', rules)).toBe(true)
    expect(isIgnored('src/index.js', rules)).toBe(false)
  })

  it('n\'envoie pas les fichiers exclus dans le contexte, mais toujours le Dockerfile', async () => {
    const dir = tempBase('ctx-')
    writeFileSync(join(dir, 'Dockerfile'), 'FROM scratch\n')
    writeFileSync(join(dir, '.dockerignore'), '*\n!app.txt\n')
    writeFileSync(join(dir, 'app.txt'), 'ok')
    writeFileSync(join(dir, '.env'), 'SECRET=1')
    const { stream } = await contextTar(dir, 'Dockerfile')
    const names: string[] = []
    const ex = extract()
    ex.on('entry', (h, s, next) => { names.push(h.name); s.on('end', next); s.resume() })
    await new Promise((resolve, reject) => { ex.on('finish', () => resolve(undefined)); ex.on('error', reject); stream.pipe(ex as never) })
    expect(names.sort()).toEqual(['.dockerignore', 'Dockerfile', 'app.txt'])
    rmSync(dir, { recursive: true, force: true })
  })
})

describe.skipIf(!dockerAvailable)('build via le Runner (Docker réel)', () => {
  let base: string
  let t: Awaited<ReturnType<typeof startTestRunner>>
  const built: string[] = []

  beforeAll(async () => {
    base = tempBase('build-it-')
    mkdirSync(join(base, 'builds'))
    t = await startTestRunner([join(base, 'builds')], () => {}, SOCKET)
  }, 60_000)

  afterAll(async () => {
    if (built.length) await t.runner.removeImages(ctx, { tags: built }).catch(() => {})
    await t?.close()
    rmSync(base, { recursive: true, force: true })
  })

  const project = (name: string, files: Record<string, string>) => {
    const dir = join(base, 'builds', name)
    mkdirSync(dir, { recursive: true })
    for (const [f, c] of Object.entries(files)) {
      mkdirSync(join(dir, f, '..'), { recursive: true })
      writeFileSync(join(dir, f), c)
    }
    return dir
  }
  const input = (contextDir: string, imageTag: string, over = {}) => ({ contextDir, dockerfile: 'Dockerfile', imageTag, buildArgs: {}, labels: {}, target: null, timeoutSec: 120, maxLogBytes: 1_000_000, ...over })

  it('annonce le build dans health', async () => {
    expect((await t.runner.health()).actions).toContain('build')
  })

  it('construit une image et transmet les logs au fil de l\'eau', async () => {
    const dir = project('ok', { 'Dockerfile': 'FROM scratch\nARG VERSION=0\nLABEL app.version=$VERSION\nCOPY site/ /site/\n', 'site/index.html': '<h1>ok</h1>' })
    const logs: RunnerLogLine[] = []
    const r = await t.runner.build(ctx, input(dir, tag('ok'), { buildArgs: { VERSION: '42' }, labels: { 'platform.project': 'it' } }), l => logs.push(l))
    built.push(tag('ok'))
    expect(r.imageId).toMatch(/^sha256:[a-f0-9]{64}$/)
    expect(r.imageTag).toBe(tag('ok'))
    expect(logs.length).toBeGreaterThan(0)
    expect(logs.map(l => l.line).join('\n')).toMatch(/COPY site/)
  }, 120_000)

  it('remonte proprement l\'échec d\'un Dockerfile invalide', async () => {
    const dir = project('ko', { Dockerfile: 'FROM scratch\nCOPY absent.txt /\n' })
    const logs: RunnerLogLine[] = []
    await expect(t.runner.build(ctx, input(dir, tag('ko')), l => logs.push(l))).rejects.toThrow(/Échec du build|absent/)
    expect(logs.some(l => l.stream === 'stderr')).toBe(true)
  }, 120_000)

  it('refuse un contexte contenant un lien symbolique', async () => {
    const dir = project('link', { Dockerfile: 'FROM scratch\n' })
    symlinkSync('/etc/passwd', join(dir, 'passwd'))
    await expect(t.runner.build(ctx, input(dir, tag('link')), () => {})).rejects.toThrow(/lien symbolique/)
  })

  it('refuse un tag hors de l\'espace platform/ et un contexte hors racines', async () => {
    await expect(t.runner.build(ctx, input(join(base, 'builds/ok'), 'nginx:latest'), () => {})).rejects.toThrow()
    await expect(t.runner.build(ctx, input('/etc', tag('etc')), () => {})).rejects.toMatchObject({ status: 403 })
  })

  it('supprime uniquement des images de la plateforme', async () => {
    await expect(t.runner.removeImages(ctx, { tags: ['nginx:1.27'] })).rejects.toMatchObject({ status: 403 })
    const r = await t.runner.removeImages(ctx, { tags: [tag('ok'), tag('inexistante')] })
    expect(r.removed).toEqual([tag('ok')])
    expect(r.missing).toEqual([tag('inexistante')])
    built.length = 0
  })
})

describe('.dockerignore : sémantique Docker', () => {
  it.each([
    ['*', '.env', true],
    ['*', 'src/a.js', true],
    ['**/*.pem', 'a/b/c/key.pem', true],
    ['**/*.pem', 'key.pem', true],
    ['*.md', 'docs/a.md', false],
    ['docs/*.md', 'docs/a.md', true],
    ['?.txt', 'a.txt', true],
    ['?.txt', 'ab.txt', false],
    ['[ab].txt', 'b.txt', true],
    ['.git', '.git/config', true],
    ['a.b', 'axb', false],
  ])('motif %s sur %s → exclu=%s', (pattern, path, expected) => {
    expect(isIgnored(path, parseDockerignore(pattern))).toBe(expected)
  })
})
