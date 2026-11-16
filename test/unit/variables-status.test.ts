import { describe, expect, it } from 'vitest'
import { initOnlyHint } from '../../shared/utils/variables'
import { variablesNotDeployed } from '../../server/services/projects'

describe('variables à déployer', () => {
  const meta = { A: { updatedAt: '2026-10-12T10:00:00.000Z' }, B: { updatedAt: '2026-10-12T12:00:00.000Z' }, C: { updatedAt: '1970-01-01T00:00:00.000Z' } }
  it('liste les variables modifiées après le déploiement en service', () => {
    expect(variablesNotDeployed(meta, new Date('2026-10-12T11:00:00.000Z'))).toEqual(['B'])
  })
  it('rien sans déploiement en service', () => {
    expect(variablesNotDeployed(meta, null)).toEqual([])
  })
})

describe('variables lues seulement à l\'initialisation', () => {
  it('signale les mots de passe initiaux et de base', () => {
    expect(initOnlyHint('HARBOR_ADMIN_PASSWORD')).toMatch(/premier démarrage/)
    expect(initOnlyHint('POSTGRES_PASSWORD')).toMatch(/création de la base/)
    expect(initOnlyHint('DB_PASSWORD')).toMatch(/mot de passe réel/)
  })
  it('ignore les autres variables', () => {
    expect(initOnlyHint('LOG_LEVEL')).toBeNull()
  })
})
