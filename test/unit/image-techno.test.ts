import { describe, expect, it } from 'vitest'
import { compareImageVersions, imageTechno } from '../../shared/utils/image-techno'

describe('imageTechno', () => {
  it('sépare techno et version', () => {
    expect(imageTechno('n8nio/n8n:2.45.7')).toEqual({ techno: 'n8nio/n8n', version: '2.45.7' })
    expect(imageTechno('docker.io/library/postgres:16-alpine')).toEqual({ techno: 'postgres', version: '16-alpine' })
    expect(imageTechno('ghcr.io/org/app:v1.2.0')).toEqual({ techno: 'ghcr.io/org/app', version: 'v1.2.0' })
    expect(imageTechno('registre.interne:5000/equipe/api:3')).toEqual({ techno: 'registre.interne:5000/equipe/api', version: '3' })
    expect(imageTechno('platform/demo-web:r-0002-abc123')).toEqual({ techno: 'platform/demo-web', version: 'r-0002-abc123' })
  })
  it('sans tag : empreinte courte, sinon latest', () => {
    expect(imageTechno(`redis@sha256:${'a'.repeat(64)}`)).toEqual({ techno: 'redis', version: 'aaaaaaaaaaaa' })
    expect(imageTechno('traefik')).toEqual({ techno: 'traefik', version: 'latest' })
    expect(imageTechno(`sha256:${'b'.repeat(64)}`)).toEqual({ techno: 'image sans nom', version: 'bbbbbbbbbbbb' })
  })
  it('trie les versions de la plus récente à la plus ancienne', () => {
    expect(['2.9.1', '2.45.7', 'latest', '2.10.0'].sort(compareImageVersions)).toEqual(['2.45.7', '2.10.0', '2.9.1', 'latest'])
    expect(['16-alpine', '17-alpine', '15-alpine'].sort(compareImageVersions)).toEqual(['17-alpine', '16-alpine', '15-alpine'])
  })
})
