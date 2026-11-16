/** Cause probable d'un service en difficulté (diagnostic d'une cible). */
import { describe, expect, it } from 'vitest'
import { diagnoseService, exitMeaning, notableLines, summarize } from '../../server/lib/diagnostic'

const base = { service: 'web', container: 'shop-web-1', containerId: 'abc', image: 'nginx:1.27', state: 'running' as const, health: null, exitCode: null, oomKilled: false, restartCount: 0, startedAt: null, finishedAt: null, healthLog: [], notableLogs: [], tail: [] }
const ctx = { projectId: 'p', endpointId: 'e', stack: 'shop', allStopped: false }

describe('diagnostic d\'un service', () => {
  it('codes de sortie expliqués', () => {
    expect(exitMeaning(0, false)).toBe('arrêt normal')
    expect(exitMeaning(137, true)).toMatch(/OOM/)
    expect(exitMeaning(137, false)).toMatch(/SIGKILL/)
    expect(exitMeaning(143, false)).toMatch(/SIGTERM/)
  })

  it('conteneur absent : redéployer', () => {
    const [f] = diagnoseService({ ...base, state: 'missing', container: null, containerId: null }, ctx)
    expect(f).toMatchObject({ severity: 'error', title: 'Conteneur absent', actions: [{ kind: 'redeploy' }] })
  })

  it('OOM : mémoire, redémarrer le service', () => {
    const [f] = diagnoseService({ ...base, state: 'exited', exitCode: 137, oomKilled: true }, ctx)
    expect(f!.title).toMatch(/mémoire/)
    expect(f!.actions[0]).toEqual({ kind: 'restart-service', service: 'web' })
  })

  it('erreur au démarrage : dernière ligne d\'erreur citée', () => {
    const [f] = diagnoseService({ ...base, state: 'exited', exitCode: 1, notableLogs: ['FATAL: password authentication failed'] }, ctx)
    expect(f).toMatchObject({ severity: 'error' })
    expect(f!.detail).toContain('password authentication failed')
  })

  it('stack entièrement arrêtée : constat d\'arrêt, pas d\'erreur', () => {
    const [f] = diagnoseService({ ...base, state: 'exited', exitCode: 0 }, { ...ctx, allStopped: true })
    expect(f).toMatchObject({ severity: 'warning' })
    expect(summarize([{ ...base, state: 'exited', exitCode: 0, findings: [f!] }], { ...ctx, allStopped: true }).actions).toEqual([{ kind: 'start' }])
  })

  it('healthcheck trop lent : lien vers les réglages des healthchecks', () => {
    const [f] = diagnoseService({ ...base, health: 'unhealthy', healthLog: [{ at: '', exitCode: -1, output: 'timed out starting health check for container' }] }, ctx)
    expect(f!.title).toBe('Healthcheck trop lent')
    expect(f!.actions[0]).toMatchObject({ kind: 'link', to: '/projects/p?tab=settings' })
  })

  it('redémarrage en boucle', () => {
    const [f] = diagnoseService({ ...base, state: 'restarting', restartCount: 12 }, ctx)
    expect(f!.title).toMatch(/boucle/)
  })

  it('service sain', () => {
    expect(diagnoseService({ ...base, health: 'healthy' }, ctx)).toEqual([{ severity: 'ok', title: 'Sain', detail: null, actions: [] }])
  })

  it('lignes notables : erreurs seulement, les dernières', () => {
    expect(notableLines(['GET / 200', 'ERROR db refused', 'ok', 'connection timed out'])).toEqual(['ERROR db refused', 'connection timed out'])
  })
})

describe('stack arrêtée en bloc', () => {
  it('pas de « boucle » ni d\'erreur applicative pour les codes de sortie consécutifs à l\'arrêt', () => {
    const stopped = { projectId: 'p', endpointId: 'e', stack: 'shop', allStopped: true }
    const loop = diagnoseService({ ...base, state: 'exited', exitCode: 0, restartCount: 5 }, stopped)
    expect(loop[0]!.title).toMatch(/^Arrêté/)
    const err = diagnoseService({ ...base, state: 'exited', exitCode: 2 }, stopped)
    expect(err[0]).toMatchObject({ severity: 'warning' })
  })
})
