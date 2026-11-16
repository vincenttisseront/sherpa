import { describe, expect, it } from 'vitest'
import { classify } from '../../server/services/healthcheck'
import type { ContainerState } from '../../server/adapters/portainer/types'

const c = (o: Partial<ContainerState>): ContainerState => ({ id: 'x', name: 'x', service: 'jobservice', status: 'running', running: true, health: 'starting', exitCode: null, restartCount: 0, startedAt: '2026-10-12T11:54:00Z', image: 'img', imageId: 'sha256:1', labels: {}, ...o })

describe('santé après déploiement', () => {
  it('démarrage : redémarrages en attendant une dépendance tolérés pendant la grâce', () => {
    // Cas Harbor : jobservice redémarre tant que core ne répond pas.
    expect(classify([c({ status: 'restarting', running: true, restartCount: 3, exitCode: 2 })], { tolerateRestarts: true })).toMatchObject({ state: 'starting' })
    expect(classify([c({ status: 'exited', running: false, restartCount: 2, exitCode: 2 })], { tolerateRestarts: true })).toMatchObject({ state: 'starting' })
    expect(classify([c({ restartCount: 4, health: 'healthy' })], { tolerateRestarts: true })).toMatchObject({ state: 'healthy' })
  })

  it('hors grâce, ou au-delà de 10 redémarrages : boucle de redémarrage', () => {
    expect(classify([c({ status: 'restarting', running: true, restartCount: 3, exitCode: 2 })])).toMatchObject({ state: 'restarting' })
    expect(classify([c({ status: 'restarting', running: true, restartCount: 12, exitCode: 1 })], { tolerateRestarts: true })).toMatchObject({ state: 'restarting' })
  })

  it('après la grâce, seuls les nouveaux redémarrages comptent', () => {
    expect(classify([c({ restartCount: 4, health: 'healthy' })], { restartBaseline: 4 })).toMatchObject({ state: 'healthy' })
    expect(classify([c({ status: 'restarting', running: true, restartCount: 7 })], { restartBaseline: 4 })).toMatchObject({ state: 'restarting' })
  })

  it('arrêt sans redémarrage, healthcheck en échec : échec immédiat', () => {
    expect(classify([c({ status: 'exited', running: false, exitCode: 1 })], { tolerateRestarts: true })).toMatchObject({ state: 'exited' })
    expect(classify([c({ health: 'unhealthy' })], { tolerateRestarts: true })).toMatchObject({ state: 'unhealthy' })
  })
})
