import { describe, expect, it } from 'vitest'
import { assertTransition, canTransition } from '../../shared/utils/deployment-status'

describe('machine d\'états des déploiements', () => {
  it('suit le chemin nominal', () => {
    const path = ['DRAFT', 'VALIDATING', 'QUEUED', 'PREPARING_FILES', 'BUILDING', 'DEPLOYING', 'HEALTH_CHECKING', 'HEALTHY'] as const
    for (let i = 1; i < path.length; i++) expect(canTransition(path[i - 1]!, path[i]!)).toBe(true)
  })

  it('n\'est annulable qu\'avant exécution', () => {
    expect(canTransition('QUEUED', 'CANCELLED')).toBe(true)
    expect(canTransition('BUILDING', 'CANCELLED')).toBe(false)
  })

  it('permet les actions de cycle de vie', () => {
    expect(canTransition('QUEUED', 'DEPLOYING')).toBe(true)
    expect(canTransition('DEPLOYING', 'STOPPED')).toBe(true)
    expect(canTransition('QUEUED', 'DELETING')).toBe(true)
    expect(canTransition('DELETING', 'DELETED')).toBe(true)
  })

  it('refuse les transitions incohérentes', () => {
    expect(() => assertTransition('DELETED', 'QUEUED')).toThrow(/interdite/)
    expect(() => assertTransition('DRAFT', 'HEALTHY')).toThrow()
  })
})
