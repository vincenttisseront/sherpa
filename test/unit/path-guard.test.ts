import { describe, expect, it } from 'vitest'
import { PathViolation, assertInsideProject, normalizeAbsolute, projectLayout, validateRelativeEntry, validateRoot } from '../../server/utils/path-guard'

const cfg = {
  workingRoot: '/srv/deployments',
  buildRoot: '/srv/builds',
  tmpRoot: '/srv/tmp',
  runtimeRoot: '/srv/apps-data',
  forbiddenPaths: ['/srv/deployments/legacy'],
}

describe('normalizeAbsolute', () => {
  it.each([
    ['relatif', 'srv/app'],
    ['..', '/srv/../etc'],
    ['.', '/srv/./app'],
    ['antislash', '/srv\\app'],
    ['caractère nul', '/srv/a\u0000b'],
    ['tilde', '/~/app'],
    ['vide', ''],
  ])('refuse %s', (_label, input) => {
    expect(() => normalizeAbsolute(input)).toThrow(PathViolation)
  })

  it('supprime les doubles slashs et le slash final', () => {
    expect(normalizeAbsolute('/srv//deployments/')).toBe('/srv/deployments')
  })
})

describe('validateRoot', () => {
  it.each(['/', '/etc', '/etc/app', '/var/run/docker.sock', '/var/lib/docker/volumes', '/usr/local/app', '/proc/1', '/srv', '/opt', '/home'])('refuse %s', (p) => {
    expect(() => validateRoot(p)).toThrow(PathViolation)
  })

  it('refuse un chemin interdit par la configuration', () => {
    expect(() => validateRoot('/srv/deployments/legacy/x', cfg.forbiddenPaths)).toThrow(/interdit par la configuration/)
  })

  it('accepte un dossier dédié de premier niveau (/tools), pas un dossier partagé', () => {
    expect(validateRoot('/tools')).toBe('/tools')
    expect(() => validateRoot('/srv')).toThrow(/dossier partagé/)
  })

  it('accepte une racine dédiée', () => {
    expect(validateRoot('/srv/deployments/production')).toBe('/srv/deployments/production')
  })

  it('ne confond pas un préfixe textuel avec un répertoire parent', () => {
    expect(validateRoot('/srv/etcetera')).toBe('/srv/etcetera')
  })
})

describe('projectLayout', () => {
  const prod = { ...cfg, workingRoot: '/srv/deployments/production', runtimeRoot: '/srv/apps-data/production' }
  const layout = projectLayout(prod, 'billing-api')

  it('construit l\'arborescence §6.2', () => {
    expect(layout.projectDir).toBe('/srv/deployments/production/billing-api')
    expect(layout.releasesDir).toBe('/srv/deployments/production/billing-api/releases')
    expect(layout.runtimeDir).toBe('/srv/apps-data/production/billing-api')
    expect(layout.tmpDir).toBe('/srv/tmp/billing-api')
    const r = layout.release('r-0042')
    expect(r.sourceDir).toBe('/srv/deployments/production/billing-api/releases/r-0042/source')
    expect(r.composeFile).toBe('/srv/deployments/production/billing-api/releases/r-0042/compose.yml')
  })

  it.each(['../x', 'Billing', 'a/b', '', '-x'])('refuse le slug projet %j', (slug) => {
    expect(() => projectLayout(cfg, slug)).toThrow(PathViolation)
  })

  it('refuse un identifiant de release hostile', () => {
    expect(() => layout.release('../../etc')).toThrow(PathViolation)
  })

  it('exige des répertoires runtime et de travail séparés', () => {
    expect(() => projectLayout({ ...cfg, runtimeRoot: '/srv/deployments/data' }, 'app')).toThrow(/distinct/)
  })

  it('bloque les chemins d\'un projet voisin', () => {
    expect(() => assertInsideProject('/srv/deployments/production/billing-api-v2/releases', layout)).toThrow(/périmètre/)
    expect(() => assertInsideProject('/srv/deployments/production/other/x', layout)).toThrow(PathViolation)
    expect(assertInsideProject('/srv/deployments/production/billing-api/shared/db', layout)).toBe('/srv/deployments/production/billing-api/shared/db')
  })
})

describe('validateRelativeEntry (entrées ZIP / sous-répertoires)', () => {
  it.each(['../evil', 'a/../../evil', '/etc/passwd', 'C:/x', 'a\\b', ''])('refuse %j', (e) => {
    expect(() => validateRelativeEntry(e)).toThrow(PathViolation)
  })

  it('normalise une entrée valide', () => {
    expect(validateRelativeEntry('./app//docker/compose.yml')).toBe('app/docker/compose.yml')
  })
})
