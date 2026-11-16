/** Versions d'images : comparaison seulement entre tags de même forme. */
import { describe, expect, it } from 'vitest'
import { STATEFUL_IMAGE, newerVersions, parseTag, upgradeLevel } from '../../shared/utils/image-version'

describe('versions d\'images', () => {
  it('netbox : forme v#.#-#.#.#, mineure et majeure', () => {
    const tags = ['v4.7-5.1.1', 'v4.7-5.1.2', 'v4.8-5.2.0', 'v5.0-6.0.0', 'v4.8-5.2.0-ldap', 'latest', 'snapshot', 'v4.9-beta1-5.3.0']
    const r = newerVersions('v4.7-5.1.1', tags)!
    expect(r.compatible).toEqual({ tag: 'v4.8-5.2.0', level: 'minor' })
    expect(r.major).toEqual({ tag: 'v5.0-6.0.0', level: 'major' })
  })

  it('suffixe de variante conservé (alpine, debian)', () => {
    const r = newerVersions('18-alpine', ['18-alpine', '18.1-alpine', '19-alpine', '19', '20-bookworm'])!
    expect(r.compatible).toBeNull()
    expect(r.major).toEqual({ tag: '19-alpine', level: 'major' })
    expect(newerVersions('2.11.7-alpine', ['2.11.8-alpine', '2.12.0-alpine', '2.11.9'])!.compatible).toEqual({ tag: '2.12.0-alpine', level: 'minor' })
    expect(newerVersions('1.5.4-debian', ['1.5.5-debian', '1.5.5'])!.compatible).toEqual({ tag: '1.5.5-debian', level: 'patch' })
  })

  it('semver avec ou sans v, nombres à plusieurs chiffres', () => {
    expect(newerVersions('v2.15.4', ['v2.15.10', 'v2.15.9', 'v2.16.0-rc1', '2.16.0'])!.compatible).toEqual({ tag: 'v2.15.10', level: 'patch' })
    expect(newerVersions('v1.31.5', ['v1.32.0', 'v2.0.0'])).toMatchObject({ compatible: { tag: 'v1.32.0' }, major: { tag: 'v2.0.0' } })
  })

  it('préversions ignorées, sauf si la version actuelle en est une', () => {
    expect(newerVersions('3.1.0', ['3.2.0-rc1', '3.1.1-beta'])!.compatible).toBeNull()
    expect(newerVersions('3.2.0-rc1', ['3.2.0-rc2', '3.2.0'])!.compatible).toEqual({ tag: '3.2.0-rc2', level: 'patch' })
  })

  it('tags sans version : pas de mise à niveau de version', () => {
    for (const t of ['latest', 'stable', 'main', 'local', 'a1b2c3d4e5f6a7b8']) expect(parseTag(t)).toBeNull()
    expect(newerVersions('latest', ['1.0.0'])).toBeNull()
  })

  it('aucune version plus récente', () => {
    expect(newerVersions('9.1-alpine', ['9.0-alpine', '9.1-alpine'])).toMatchObject({ compatible: null, major: null })
  })

  it('niveau du changement', () => {
    expect(upgradeLevel(parseTag('1.2.3')!, parseTag('1.2.4')!)).toBe('patch')
    expect(upgradeLevel(parseTag('1.2.3')!, parseTag('1.3.0')!)).toBe('minor')
    expect(upgradeLevel(parseTag('1.2.3')!, parseTag('2.0.0')!)).toBe('major')
  })

  it('services à données repérés', () => {
    for (const i of ['docker.io/postgres:18-alpine', 'mariadb:latest', 'docker.io/valkey/valkey:9.1-alpine', 'goharbor/harbor-db:v2.15.4']) expect(STATEFUL_IMAGE.test(i)).toBe(true)
    for (const i of ['caddy:2.11', 'netboxcommunity/netbox:v4.7-5.1.1', 'axllent/mailpit:v1.31.5']) expect(STATEFUL_IMAGE.test(i)).toBe(false)
  })
})
