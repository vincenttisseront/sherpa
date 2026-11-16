import { describe, expect, it } from 'vitest'
import { updateEngineInput } from '../../shared/schemas/update-engine'
import { latestStableTag } from '../../server/lib/registry'
import { engineOutdated, isRetiredImage, normalizeImage, repositoryOf } from '../../server/services/update-engine'

describe('moteur de mise à jour des images', () => {
  it('références comparables (registre docker.io implicite, tag, empreinte)', () => {
    expect(normalizeImage('docker.io/nickfedor/watchtower:1.23.0')).toBe('nickfedor/watchtower:1.23.0')
    expect(repositoryOf('nickfedor/watchtower:1.23.0@sha256:abc')).toBe('nickfedor/watchtower')
    expect(repositoryOf('ghcr.io/nicholas-fedor/watchtower:1.23.0')).toBe('ghcr.io/nicholas-fedor/watchtower')
    expect(repositoryOf('registry:5000/watchtower')).toBe('registry:5000/watchtower')
  })
  it('projet archivé reconnu et refusé au choix', () => {
    expect(isRetiredImage('containrrr/watchtower:latest')).toBe(true)
    expect(isRetiredImage('nickfedor/watchtower:1.23.0')).toBe(false)
    expect(updateEngineInput.safeParse({ repository: 'containrrr/watchtower', tag: '1.7.1' }).success).toBe(false)
    expect(updateEngineInput.safeParse({ repository: 'nickfedor/watchtower', tag: 'latest' }).success).toBe(false)
    expect(updateEngineInput.safeParse({ repository: 'nickfedor/watchtower', tag: '1.23.0' }).success).toBe(true)
  })
  it('cible à basculer si l\'image en place diffère (ou est inconnue)', () => {
    const current = 'nickfedor/watchtower:1.23.0@sha256:aa'
    expect(engineOutdated('docker.io/nickfedor/watchtower:1.23.0@sha256:aa', current)).toBe(false)
    expect(engineOutdated('nickfedor/watchtower:1.22.3', current)).toBe(true)
    expect(engineOutdated(null, current)).toBe(true)
  })
  it('dernière version stable parmi les tags publiés', () => {
    expect(latestStableTag(['latest', 'v1.11.7', '1.22.3', '1.23.0', 'riscv64-1.23.0', '1.23.0-rc1', '1.9.10'])).toBe('1.23.0')
    expect(latestStableTag(['latest', 'dev'])).toBeNull()
  })
})
