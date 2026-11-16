import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { BuildTrace, buildkitUnavailable, decodeStatus } from '../../runner/buildkit'

/** Flux réel d'un build BuildKit (version=2, contexte tar) capturé sur Docker 29. */
const stream = (name: string) => readFileSync(`test/fixtures/buildkit/${name}.jsonl`, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l) as { id?: string, aux?: unknown, error?: string })
const run = (name: string) => {
  const lines: string[] = []
  const trace = new BuildTrace((l, s) => lines.push(`${s === 'stderr' ? '!' : ' '} ${l}`))
  for (const m of stream(name)) if (m.id === 'moby.buildkit.trace' && typeof m.aux === 'string') trace.feed(m.aux)
  trace.flush()
  return lines
}

describe('décodage de la progression BuildKit', () => {
  it('sommets et journaux d\'un message réel', () => {
    const all = stream('cold').filter(m => m.id === 'moby.buildkit.trace').map(m => decodeStatus(m.aux as string))
    const names = new Set(all.flatMap(s => s.vertexes.map(v => v.name)))
    expect([...names].some(n => /^\[2\/3\] RUN echo "ligne un"/.test(n))).toBe(true)
    expect(all.flatMap(s => s.logs).map(l => l.msg).join('')).toContain('ligne un')
  })
  it('build à froid : étapes, sortie standard et d\'erreur', () => {
    const lines = run('cold')
    expect(lines.some(l => l.startsWith('  ▶ [2/3] RUN echo "ligne un"'))).toBe(true)
    expect(lines).toContain('  ligne un')
    expect(lines).toContain('! erreur stderr')
    expect(lines.some(l => /✓ \[3\/3\] RUN echo second — terminé en [\d.]+ s/.test(l))).toBe(true)
    // Étapes internes omises.
    expect(lines.some(l => l.includes('[internal]') || l.includes('exporting'))).toBe(false)
  })
  it('build en cache : étapes marquées, sans réexécution', () => {
    const lines = run('warm')
    expect(lines.some(l => /✓ \[2\/3\] RUN echo "ligne un".* — en cache/.test(l))).toBe(true)
    expect(lines.some(l => /^ {2}▶ \[[23]\/3\]/.test(l))).toBe(false)
    expect(lines).not.toContain('  ligne un')
  })
  it('échec d\'une commande : étape en erreur et sortie avant l\'échec', () => {
    const lines = run('err')
    expect(lines).toContain('  avant')
    expect(lines.some(l => l.startsWith('! ✗ [2/2] RUN echo avant && exit 3 : process "/bin/sh -c echo avant && exit 3" did not complete successfully: exit code: 3'))).toBe(true)
    expect(stream('err').at(-1)!.error).toContain('exit code: 3')
  })
  it('flux corrompu ou tronqué : ignoré sans lever d\'erreur', () => {
    const lines: string[] = []
    const t = new BuildTrace(l => lines.push(l))
    t.feed('pas-du-base64-!!')
    t.feed(Buffer.from([0x0A, 0xFF, 0x01]).toString('base64'))
    expect(lines).toEqual([])
  })
})

describe('buildkitUnavailable', () => {
  it('repli sur le builder classique seulement si BuildKit ou son frontend manque', () => {
    expect(buildkitUnavailable('failed to solve: failed to resolve source metadata for docker.io/docker/dockerfile:1: dial tcp: lookup registry-1.docker.io')).toBe(true)
    expect(buildkitUnavailable('failed to resolve source metadata for registre.interne/dockerfile:9: connexion refusée')).toBe(true)
    expect(buildkitUnavailable('Docker a refusé le build (400) buildkit is not supported on this daemon')).toBe(true)
    expect(buildkitUnavailable('process "/bin/sh -c npm ci" did not complete successfully: exit code: 1')).toBe(false)
    expect(buildkitUnavailable('failed to solve: dockerfile parse error on line 3: unknown instruction: RUNN')).toBe(false)
  })
})
