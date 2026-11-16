/** Builds par l'API Docker avec BuildKit (moteur local requis) : journal, cache, échec, repli sur le builder classique. */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { DockerError, createDockerClient } from '../../runner/docker'

const socket = process.env.DOCKER_SOCKET ?? '/var/run/docker.sock'
const docker = createDockerClient(socket)
const available = await docker.ping()
const base = mkdtempSync(join(tmpdir(), 'bk-'))
const tags: string[] = []
const nonce = Date.now().toString(36)

function context(name: string, dockerfile: string) {
  const dir = join(base, name)
  mkdirSync(dir)
  writeFileSync(join(dir, 'Dockerfile'), dockerfile)
  return dir
}
async function build(name: string, dockerfile: string, o: { buildkit: boolean, noCache?: boolean, stallMs?: number } = { buildkit: true }) {
  const lines: string[] = []
  const tag = `platform/bk-test-${name}-${nonce}:1`
  tags.push(tag)
  const r = await docker.build({ contextDir: context(`${name}-${lines.length}-${Math.random().toString(36).slice(2, 6)}`, dockerfile), dockerfile: 'Dockerfile', tag, buildArgs: {}, labels: { 'platform.managed': 'true' }, timeoutMs: 300_000, maxLogBytes: 1_000_000, onLog: l => lines.push(l), buildkit: o.buildkit, noCache: o.noCache, buildkitStallMs: o.stallMs })
  return { ...r, lines, tag }
}

describe.skipIf(!available)('build BuildKit', () => {
  afterAll(async () => {
    await docker.removeImages(tags).catch(() => {})
    rmSync(base, { recursive: true, force: true })
  })

  it('journal des étapes et des commandes, puis étapes en cache', async () => {
    const df = `FROM busybox:1.37\nRUN echo "marqueur-${nonce}" && echo "sur stderr" >&2\nRUN echo deux\n`
    const cold = await build('cold', df)
    expect(cold.imageId).toMatch(/^sha256:[0-9a-f]{64}$/)
    expect(cold.lines).toContain(`marqueur-${nonce}`)
    expect(cold.lines.some(l => /^▶ \[2\/3\] RUN echo "marqueur/.test(l))).toBe(true)
    expect(cold.lines.some(l => l.startsWith('BuildKit : limite mémoire'))).toBe(true)
    // Même Dockerfile : le cache est repris, sans réexécuter les commandes.
    const warm = await build('cold', df)
    expect(warm.lines.some(l => /✓ \[2\/3\] RUN echo .* — en cache/.test(l))).toBe(true)
    expect(warm.lines).not.toContain(`marqueur-${nonce}`)
  }, 300_000)

  it('builds successifs avec le même client : connexion neuve à chaque fois, aucun repli', async () => {
    // Une connexion gardée ouverte était réutilisée et le moteur ne la traitait plus : un build sur deux se figeait
    // (contexte de plusieurs fichiers, Dockerfile nommé).
    for (let i = 0; i < 4; i++) {
      const dir = context(`seq${i}-${Math.random().toString(36).slice(2, 6)}`, '')
      for (const s of ['a', 'b', 'c']) writeFileSync(join(dir, `Dockerfile.${s}`), `FROM busybox:1.37\nRUN sleep 1 && echo ${s}-${i}-${nonce} > /service\nCMD ["sleep", "3600"]\n`)
      writeFileSync(join(dir, 'compose.yml'), 'services:\n  a:\n    build: .\n')
      const lines: string[] = []
      const tag = `platform/bk-test-seq${i}-${nonce}:1`
      tags.push(tag)
      await docker.build({ contextDir: dir, dockerfile: 'Dockerfile.a', tag, buildArgs: {}, labels: { 'platform.managed': 'true' }, timeoutMs: 120_000, maxLogBytes: 1_000_000, buildkit: true, buildkitStallMs: 20_000, onLog: l => lines.push(l) })
      expect(lines.some(l => l.startsWith('BuildKit indisponible')), `build ${i} : ${lines.join(' | ').slice(0, 300)}`).toBe(false)
    }
  }, 300_000)

  it('échec d\'une commande : erreur claire, pas de repli sur le builder classique', async () => {
    const err = await build('fail', `FROM busybox:1.37\nRUN echo avant-${nonce} && exit 3\n`).catch(e => e as Error)
    expect(err).toBeInstanceOf(DockerError)
    expect((err as Error).message).toContain('exit code: 3')
  }, 300_000)

  it('frontend de Dockerfile introuvable : build refait avec le builder classique', async () => {
    const r = await build('syntax', `# syntax=registry.invalid/dockerfile:9\nFROM busybox:1.37\nRUN echo classique-${nonce}\n`)
    expect(r.lines.some(l => l.startsWith('BuildKit indisponible'))).toBe(true)
    expect(r.lines.some(l => l.includes(`classique-${nonce}`))).toBe(true)
    expect(r.imageId).toMatch(/^sha256:/)
  }, 300_000)

  it('builder classique inchangé quand BuildKit est désactivé', async () => {
    const r = await build('classic', `FROM busybox:1.37\nRUN echo classique2-${nonce}\n`, { buildkit: false })
    expect(r.lines, JSON.stringify(r.lines)).toSatisfy((x: string[]) => x.some(l => /^Step 2\/\d+ : RUN/.test(l)))
    expect(r.lines.some(l => l.startsWith('BuildKit'))).toBe(false)
  }, 300_000)
})
