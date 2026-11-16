import { describe, expect, it } from 'vitest'
import { matchingArchive, versionlessName } from '../../server/lib/release-match'

describe('fichier équivalent d\'une release suivante', () => {
  const files = (names: string[]) => [
    ...names.map((name, i) => ({ key: `asset:${i + 1}`, name, kind: 'asset' as const, importable: !name.endsWith('.sha256') })),
    { key: 'source:zip', name: 'src.zip', kind: 'source' as const, importable: true },
    { key: 'source:tar.gz', name: 'src.tar.gz', kind: 'source' as const, importable: true },
  ]

  it('nom sans version', () => {
    expect(versionlessName('app-1.2.0-linux.tar.gz', 'v1.2.0')).toBe('app-*-linux.tar.gz')
    expect(versionlessName('stack_v2026.10.1.zip', 'v2026.10.1')).toBe('stack_*.zip')
    expect(versionlessName('bundle-1.3.0-rc.2.zip', 'v1.3.0-rc.2')).toBe('bundle-*.zip')
  })

  it('archive attachée renommée avec la version, code source, ou rien', () => {
    const next = files(['app-1.3.0-linux.tar.gz', 'app-1.3.0-linux.tar.gz.sha256', 'app-1.3.0-windows.zip'])
    expect(matchingArchive({ key: 'asset:9', name: 'app-1.2.0-linux.tar.gz', tag: 'v1.2.0' }, next, 'v1.3.0')?.name).toBe('app-1.3.0-linux.tar.gz')
    expect(matchingArchive({ key: 'source:tar.gz', name: 'src.tar.gz', tag: 'v1.2.0' }, next, 'v1.3.0')?.key).toBe('source:tar.gz')
    expect(matchingArchive({ key: 'asset:9', name: 'deploy.zip', tag: 'v1.2.0' }, files(['deploy.zip']), 'v1.3.0')?.name).toBe('deploy.zip')
    expect(matchingArchive({ key: 'asset:9', name: 'app-1.2.0-mac.zip', tag: 'v1.2.0' }, next, 'v1.3.0')).toBeNull()
  })
})
