import { describe, expect, it } from 'vitest'
import { deploymentSteps } from '../../app/utils/deployment-steps'

const base = { action: 'deploy', error: null, failedFrom: null, sourceKind: 'github', statusDetails: {} }

describe('deploymentSteps', () => {
  it('marque les étapes passées et l\'étape en cours, avec le dernier message du statut', () => {
    const s = deploymentSteps({ ...base, status: 'BUILDING', statusDetails: { PREPARING_FILES: { message: 'Archive GitHub reçue', level: 'info' }, BUILDING: { message: 'Build web', level: 'info' } } })!
    expect(s.map(x => x.state)).toEqual(['done', 'done', 'active', 'pending', 'pending', 'pending'])
    expect(s[1]!.label).toContain('GitHub')
    expect(s[1]!.detail).toBe('Archive GitHub reçue')
    expect(s[2]!.detail).toBe('Build web')
  })

  it('place l\'erreur sur le statut d\'échec puis le rollback', () => {
    const s = deploymentSteps({ ...base, status: 'ROLLED_BACK', failedFrom: 'HEALTH_CHECKING', error: 'Healthchecks en échec' })!
    expect(s.map(x => x.state)).toEqual(['done', 'done', 'done', 'done', 'error', 'done'])
    expect(s[4]!.detail).toBe('Healthchecks en échec')
  })

  it('termine sur un succès ; pas d\'étapes pour une action de cycle de vie', () => {
    expect(deploymentSteps({ ...base, status: 'HEALTHY' })!.every(x => x.state === 'done')).toBe(true)
    expect(deploymentSteps({ ...base, action: 'restart', status: 'DEPLOYING' })).toBeNull()
    expect(deploymentSteps({ ...base, sourceKind: 'zip', status: 'QUEUED' })![1]!.label).not.toContain('GitHub')
  })
})

describe('durées des étapes', () => {
  it('formatDuration', async () => {
    const { formatDuration } = await import('../../app/utils/deployment-steps')
    expect([formatDuration(7), formatDuration(60), formatDuration(192), formatDuration(3720)]).toEqual(['7 s', '1 min 00 s', '3 min 12 s', '1 h 02 min'])
  })
  it('durée affichée sur chaque étape connue', () => {
    const s = deploymentSteps({ ...base, status: 'HEALTHY', statusDurations: { QUEUED: 2, BUILDING: 192, DEPLOYING: 15 } })!
    expect(s.find(x => x.label === 'Construction des images')?.duration).toBe('3 min 12 s')
    expect(s.find(x => x.label === 'Mise en file d\'attente')?.duration).toBe('2 s')
    expect(s.find(x => x.label.startsWith('Vérification'))?.duration).toBeUndefined()
  })
})
