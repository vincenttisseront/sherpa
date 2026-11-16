/** État réel d'une cible : santé constatée, sinon dernière opération. */
import { describe, expect, it } from 'vitest'
import { runtimeState } from '../../shared/utils/target-state'

describe('état réel d\'une cible', () => {
  it('la santé constatée fait foi sur la dernière opération', () => {
    expect(runtimeState('HEALTHY', { status: 'down' }, true)).toBe('down')
    expect(runtimeState('HEALTHY', { status: 'degraded' }, true)).toBe('degraded')
    expect(runtimeState('FAILED', { status: 'healthy' }, true)).toBe('healthy')
  })
  it('opération en cours, arrêt demandé', () => {
    expect(runtimeState('DEPLOYING', { status: 'down' }, true)).toBe('deploying')
    expect(runtimeState('STOPPED', { status: 'healthy' }, true)).toBe('stopped')
  })
  it('sans santé constatée : dernière opération', () => {
    expect(runtimeState('HEALTHY', null, true)).toBe('healthy')
    expect(runtimeState('FAILED', null, false)).toBe('failed')
    expect(runtimeState(null, null, false)).toBe('unknown')
  })
})
