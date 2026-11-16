import { describe, expect, it } from 'vitest'
import { isPublicRegistry, parseImageRef } from '../../server/lib/registry'

describe('références d\'images', () => {
  it.each([
    ['postgres:18-alpine', { registry: 'docker.io', repository: 'library/postgres', tag: '18-alpine', digest: null }],
    ['docker.io/netboxcommunity/netbox:v4.7-5.1.1', { registry: 'docker.io', repository: 'netboxcommunity/netbox', tag: 'v4.7-5.1.1' }],
    ['phpipam/phpipam-www', { registry: 'docker.io', repository: 'phpipam/phpipam-www', tag: 'latest' }],
    ['ghcr.io/aquasecurity/trivy:0.58.1', { registry: 'ghcr.io', repository: 'aquasecurity/trivy', tag: '0.58.1' }],
    ['registry.interne:5000/app/api:1.2', { registry: 'registry.interne:5000', repository: 'app/api', tag: '1.2' }],
    [`nginx@sha256:${'a'.repeat(64)}`, { registry: 'docker.io', repository: 'library/nginx', tag: null, digest: `sha256:${'a'.repeat(64)}` }],
  ])('%s', (ref, expected) => {
    expect(parseImageRef(ref)).toMatchObject(expected)
  })

  it('refuse les références illisibles ; seuls les registres publics sont interrogés', () => {
    expect(parseImageRef('Nginx:latest')).toBeNull()
    expect(parseImageRef('a b')).toBeNull()
    expect(isPublicRegistry('docker.io')).toBe(true)
    expect(isPublicRegistry('registry.interne:5000')).toBe(false)
    expect(isPublicRegistry('169.254.169.254')).toBe(false)
  })
})
