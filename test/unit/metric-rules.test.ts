import { describe, expect, it } from 'vitest'
import { type Sample, evaluateRule, memoryPercent } from '../../server/lib/metric-rules'

const NOW = Date.UTC(2026, 10, 13, 12, 0, 0)
/** `n` relevés d'une minute se terminant à NOW. */
const series = (n: number, make: (i: number) => Partial<Sample>): Sample[] =>
  Array.from({ length: n }, (_, i) => ({ ts: NOW - (n - 1 - i) * 60_000, cpu: null, memory: null, memoryLimit: null, restarts: null, ...make(i) }))

describe('règles d\'alerte de ressources', () => {
  const cpu = { metric: 'cpu', threshold: 90, minutes: 10 } as const

  it('déclenche quand le CPU dépasse le seuil sur toute la durée', () => {
    expect(evaluateRule(cpu, series(10, () => ({ cpu: 95 })), NOW)).toMatchObject({ firing: true, value: 95 })
  })

  it('ne déclenche pas si un seul relevé repasse sous le seuil', () => {
    expect(evaluateRule(cpu, series(10, i => ({ cpu: i === 4 ? 40 : 99 })), NOW).firing).toBe(false)
  })

  it('exige une couverture suffisante de relevés (pas d\'alerte juste après un démarrage)', () => {
    expect(evaluateRule(cpu, series(4, () => ({ cpu: 99 })), NOW).firing).toBe(false)
    expect(evaluateRule(cpu, series(8, () => ({ cpu: 99 })), NOW).firing).toBe(true)
  })

  it('ignore les relevés hors de la fenêtre', () => {
    const old = series(10, () => ({ cpu: 99 })).map(s => ({ ...s, ts: s.ts - 60 * 60_000 }))
    expect(evaluateRule(cpu, old, NOW).firing).toBe(false)
  })

  it('calcule la mémoire en pourcentage de la limite', () => {
    expect(memoryPercent({ memory: 450, memoryLimit: 500 })).toBe(90)
    expect(memoryPercent({ memory: 450, memoryLimit: null })).toBeNull()
    expect(memoryPercent({ memory: 450, memoryLimit: 0 })).toBeNull()
    const mem = { metric: 'memory', threshold: 90, minutes: 5 } as const
    expect(evaluateRule(mem, series(5, () => ({ memory: 480, memoryLimit: 500 })), NOW).firing).toBe(true)
    expect(evaluateRule(mem, series(5, () => ({ memory: 480, memoryLimit: null })), NOW).firing).toBe(false)
  })

  it('compte les redémarrages sur la fenêtre, une recréation (compteur remis à zéro) n\'en ajoute pas', () => {
    const rule = { metric: 'restarts', threshold: 3, minutes: 15 } as const
    expect(evaluateRule(rule, series(6, i => ({ restarts: i })), NOW)).toMatchObject({ firing: true, value: 5 })
    expect(evaluateRule(rule, series(6, i => ({ restarts: i < 3 ? 10 : 0 })), NOW)).toMatchObject({ firing: false, value: 0 })
    expect(evaluateRule(rule, series(1, () => ({ restarts: 9 })), NOW).firing).toBe(false)
  })
})
