import { describe, expect, it } from 'vitest'
import { defaultPathConfig, domainPattern, portRuleInput, traefikConfigInput } from '../../shared/schemas/infra'
import { findCrossEnvironmentOverlaps, validatePathConfig, validatePortRule, validateTraefik } from '../../server/services/infra-config'

describe('validatePathConfig', () => {
  it('accepte les valeurs par défaut', () => {
    const r = validatePathConfig(defaultPathConfig('production'))
    expect(r.ok).toBe(true)
  })

  it('normalise les chemins', () => {
    const r = validatePathConfig({ ...defaultPathConfig('dev'), workingRoot: '/srv//deployments/dev/' })
    expect(r.ok && r.value.workingRoot).toBe('/srv/deployments/dev')
  })

  it('renvoie une erreur par champ', () => {
    const r = validatePathConfig({ ...defaultPathConfig('dev'), workingRoot: '/etc/app', tmpRoot: '/srv/../tmp' })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(Object.keys(r.errors).sort()).toEqual(['tmpRoot', 'workingRoot'])
  })

  it('refuse un répertoire runtime imbriqué dans le répertoire de travail', () => {
    const r = validatePathConfig({ ...defaultPathConfig('dev'), runtimeRoot: '/srv/deployments/dev/data' })
    expect(!r.ok && r.errors.runtimeRoot).toMatch(/distinct/)
  })

  it('refuse un runtime qui recouvre le répertoire temporaire', () => {
    const r = validatePathConfig({ ...defaultPathConfig('dev'), tmpRoot: '/srv/apps-data/dev/tmp' })
    expect(!r.ok && r.errors.runtimeRoot).toMatch(/temporaire/)
  })

  it('refuse un répertoire temporaire ou de build égal ou imbriqué avec le répertoire de travail (purge quotidienne)', () => {
    const base = { ...defaultPathConfig('dev'), workingRoot: '/tools/deployment', runtimeRoot: '/tools/deployment_runtime' }
    const same = validatePathConfig({ ...base, tmpRoot: '/tools/deployment', buildRoot: '/tools/deployment' })
    expect(!same.ok && Object.keys(same.errors).sort()).toEqual(['buildRoot', 'tmpRoot'])
    expect(!same.ok && same.errors.tmpRoot).toMatch(/purgé chaque jour/)
    expect(validatePathConfig({ ...base, tmpRoot: '/tools/deployment/tmp' }).ok).toBe(false)
    expect(validatePathConfig({ ...base, tmpRoot: '/tools/deployment_tmp', buildRoot: '/tools/deployment_build' }).ok).toBe(true)
  })

  it('applique les chemins interdits configurés', () => {
    const r = validatePathConfig({ ...defaultPathConfig('dev'), forbiddenPaths: ['/srv/builds'] })
    expect(!r.ok && r.errors.buildRoot).toMatch(/interdit/)
  })

  it('signale un chemin interdit mal formé', () => {
    const r = validatePathConfig({ ...defaultPathConfig('dev'), forbiddenPaths: ['/srv/../x'] })
    expect(!r.ok && r.errors['forbiddenPaths.0']).toBeTruthy()
  })
})

describe('recouvrement entre environnements', () => {
  it('accepte des racines distinctes', () => {
    expect(findCrossEnvironmentOverlaps({ dev: defaultPathConfig('dev'), production: defaultPathConfig('production') })).toEqual({})
  })

  it('refuse deux environnements sur la même racine', () => {
    const shared = defaultPathConfig('dev')
    const r = findCrossEnvironmentOverlaps({ dev: shared, production: { ...defaultPathConfig('production'), workingRoot: shared.workingRoot } })
    expect(r.production?.workingRoot).toMatch(/dev/)
    expect(r.dev?.workingRoot).toMatch(/production/)
  })

  it('refuse une racine imbriquée dans celle d\'un autre environnement, tous champs confondus', () => {
    const r = findCrossEnvironmentOverlaps({ staging: defaultPathConfig('staging'), production: { ...defaultPathConfig('production'), runtimeRoot: '/srv/tmp/staging/prod-data' } })
    expect(r.production?.runtimeRoot).toMatch(/staging/)
  })
})

describe('règles de ports', () => {
  it('refuse d\'autoriser une plage contenant un port toujours interdit', () => {
    expect(validatePortRule(portRuleInput.parse({ portFrom: 2000, portTo: 3000, policy: 'allowed' }))).toMatch(/Docker/)
    expect(validatePortRule(portRuleInput.parse({ portFrom: 22, portTo: 22, policy: 'forbidden' }))).toBeNull()
    expect(validatePortRule(portRuleInput.parse({ portFrom: 8000, portTo: 8099, policy: 'allowed' }))).toBeNull()
  })

  it('refuse une plage inversée', () => {
    expect(portRuleInput.safeParse({ portFrom: 9000, portTo: 8000, policy: 'allowed' }).success).toBe(false)
  })
})

describe('Traefik et domaines', () => {
  it.each(['apps.interne.fr', '*.apps.interne.fr', 'API.Example.COM', '*.localhost'])('accepte le domaine %s', (d) => {
    expect(domainPattern.safeParse(d).success).toBe(true)
  })
  it.each(['*', '*.fr', '*.com', '*.fr.', 'a..b.fr', 'http://x.fr', 'x.*.fr', 'localhost', '*.corp'])('refuse le domaine %s', (d) => {
    expect(domainPattern.safeParse(d).success).toBe(false)
  })

  it('exige un réseau connu et des domaines en exposition externe', () => {
    const cfg = traefikConfigInput.parse({ networkName: 'edge', exposure: 'external' })
    expect(validateTraefik(cfg, ['bridge'])).toEqual({
      networkName: expect.stringMatching(/inconnu/),
      allowedDomains: expect.stringMatching(/domaine/),
    })
  })

  it('refuse un motif de nom de routeur avec caractères spéciaux', () => {
    expect(traefikConfigInput.safeParse({ networkName: 'edge', routerNamePattern: '{project}`;rm' }).success).toBe(false)
  })
})

describe('formatBytes', () => {
  it('formate en français', async () => {
    const { formatBytes } = await import('../../shared/utils/format')
    expect(formatBytes(505)).toBe('505 o')
    expect(formatBytes(1536)).toBe('1,5 Ko')
    expect(formatBytes(100 * 1024 * 1024)).toBe('100 Mo')
    expect(formatBytes(1.5 * 1024 ** 3)).toBe('1,5 Go')
  })
})
