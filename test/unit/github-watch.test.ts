import { describe, expect, it } from 'vitest'
import { analyzeGithub, parseRegistryImage } from '../../server/lib/github-watch'
import type { GithubPackage } from '../../server/lib/github'

const now = Date.parse('2026-10-30T12:00:00Z')
const pkg = (name: string, type: GithubPackage['type'] = 'container'): GithubPackage => ({ id: 1, name, type, visibility: 'private', htmlUrl: `https://github.com/orgs/acme/packages/${type}/${name}`, repository: 'acme/app', versionCount: 2, createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-10-01T00:00:00Z' })
const version = (id: number, tags: string[], createdAt: string, name = `sha256:${String(id).padStart(64, '0')}`) => ({ id, name, tags, createdAt, updatedAt: createdAt, htmlUrl: null })

describe('connecteur GitHub : analyse', () => {
  it('lit les images du registre du compte', () => {
    expect(parseRegistryImage('ghcr.io/Acme/app/web:1.2', 'ghcr.io')).toEqual({ owner: 'acme', name: 'app/web', tag: '1.2', digest: null })
    expect(parseRegistryImage('ghcr.io/acme/app', 'ghcr.io')).toEqual({ owner: 'acme', name: 'app', tag: 'latest', digest: null })
    expect(parseRegistryImage('ghcr.io/acme/app@sha256:abc', 'ghcr.io')).toEqual({ owner: 'acme', name: 'app', tag: null, digest: 'sha256:abc' })
    expect(parseRegistryImage('docker.io/library/nginx:1', 'ghcr.io')).toBeNull()
  })

  it('versions déployées présentes ou supprimées, package introuvable', () => {
    const r = analyzeGithub({
      owner: 'acme',
      registryHost: 'ghcr.io',
      packages: [{ pkg: pkg('app'), versions: [version(2, ['1.3.0', 'latest'], '2026-10-01T00:00:00Z'), version(1, ['1.2.0'], '2026-09-01T00:00:00Z')] }, { pkg: pkg('lib', 'npm'), versions: [] }],
      artifacts: [],
      deployed: [
        { targetId: 't1', projectId: 'p1', label: 'shop (production)', service: 'web', image: 'ghcr.io/acme/app:1.2.0' },
        { targetId: 't2', projectId: 'p2', label: 'shop (staging)', service: 'web', image: 'ghcr.io/acme/app:1.1.0' },
        { targetId: 't3', projectId: 'p3', label: 'api (staging)', service: 'api', image: 'ghcr.io/acme/api:2' },
        { targetId: 't4', projectId: 'p4', label: 'autre', service: 'db', image: 'postgres:16' },
      ],
      expiringDays: 7,
      now,
    })
    const app = r.packages.find(p => p.name === 'app')!
    expect(app.latest).toMatchObject({ tags: ['1.3.0', 'latest'] })
    expect(app.usedBy.map(u => [u.targetId, u.present])).toEqual([['t1', true], ['t2', false]])
    expect(r.alerts.map(a => [a.kind, a.subject, a.targets.map(t => t.targetId)])).toEqual([
      ['package.missing', 'ghcr.io/acme/api', ['t3']],
      ['package.version-missing', 'ghcr.io/acme/app:1.1.0', ['t2']],
    ])
  })

  it('artefacts : dernier de chaque nom, expiré ou bientôt expiré', () => {
    const a = (id: number, name: string, createdAt: string, expiresAt: string, expired = false) => ({ id, name, sizeBytes: 1000, expired, createdAt, expiresAt, branch: 'main', runId: id })
    const r = analyzeGithub({
      owner: 'acme',
      registryHost: 'ghcr.io',
      packages: [],
      artifacts: [{ repository: 'acme/app', list: [
        a(1, 'bundle', '2026-07-01T00:00:00Z', '2026-09-29T00:00:00Z', true),
        a(2, 'bundle', '2026-10-28T00:00:00Z', '2027-01-26T00:00:00Z'),
        a(3, 'docs', '2026-08-01T00:00:00Z', '2026-11-02T00:00:00Z'),
        a(4, 'report', '2026-06-01T00:00:00Z', '2026-08-30T00:00:00Z', true),
      ] }],
      deployed: [],
      expiringDays: 7,
      now,
    })
    expect(r.artifacts.map(x => [x.name, x.count, x.expired])).toEqual([['bundle', 2, false], ['docs', 1, false], ['report', 1, true]])
    expect(r.alerts.map(x => [x.kind, x.subject])).toEqual([['artifact.expiring', 'acme/app · docs'], ['artifact.expired', 'acme/app · report']])
    expect(r.alerts[0]!.message).toContain('3 jour(s)')
  })
})

describe('connecteur GitHub : refus des packages', () => {
  it('explique la cause selon le type de jeton', async () => {
    const { packagesDenied } = await import('../../server/services/github-connectors')
    expect(packagesDenied('github_pat_xxx')).toMatch(/fine-grained.*jeton classique \(ghp_…\) avec read:packages/)
    expect(packagesDenied('ghp_xxx')).toMatch(/read:packages.*SSO/)
  // Import du service (et de ses dépendances) lent quand toute la suite tourne en parallèle.
  }, 30_000)
})
