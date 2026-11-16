/** Notes de version avant mise à niveau : choix des releases, nettoyage du texte, contexte du modèle. */
import { describe, expect, it } from 'vitest'
import { cleanNotes, MAX_NOTES_CHARS, MAX_RELEASES, releaseNotesParts, releasesBetween, versionOfTag } from '../../server/lib/release-notes'
import type { GithubReleaseNotes } from '../../server/lib/github'

const rel = (tag: string, body = `notes ${tag}`, prerelease = false): GithubReleaseNotes => ({ tag, name: tag, prerelease, publishedAt: '2026-10-01T00:00:00Z', htmlUrl: `https://github.com/a/b/releases/tag/${tag}`, body })

describe('version d\'un tag', () => {
  it.each([
    ['v1.4.2', '1.4.2'],
    ['1.4.2-alpine', '1.4.2'],
    ['release-2.0', '2.0'],
    ['2026.10.1', '2026.10.1'],
    ['16-alpine', '16'],
    ['latest', null],
    ['stable', null],
  ])('%s → %s', (tag, v) => {
    expect(versionOfTag(tag)).toBe(v)
  })
})

describe('releases entre deux versions', () => {
  const all = [rel('v1.5.0'), rel('v1.4.3'), rel('v1.4.2'), rel('v1.4.1'), rel('v1.4.0'), rel('v1.3.9'), rel('v1.5.0-rc1', 'rc', true), rel('nightly')]

  it('exclut la version en service, inclut la cible, de la plus ancienne à la plus récente', () => {
    expect(releasesBetween(all, '1.4.1', '1.5.0').map(r => r.tag)).toEqual(['v1.4.2', 'v1.4.3', 'v1.5.0'])
  })

  it('ignore les préversions et les tags sans version, sauf pour une cible en préversion', () => {
    expect(releasesBetween(all, '1.4.3', '1.5.0').map(r => r.tag)).toEqual(['v1.5.0'])
    expect(releasesBetween(all, '1.4.3', '1.5.0-rc1').map(r => r.tag)).toContain('v1.5.0-rc1')
    // Préversion non marquée par GitHub : écartée d'après son tag.
    expect(releasesBetween([rel('v2.0.0-beta.1'), rel('v2.0.0')], '1.9.0', '2.0.0').map(r => r.tag)).toEqual(['v2.0.0'])
  })

  it('un tag court couvre ses correctifs : 1.4 exclut 1.4.x, 1.5 inclut 1.5.x', () => {
    const r = [rel('v1.5.2'), rel('v1.5.0'), rel('v1.4.9'), rel('v1.4.0'), rel('v1.6.0')]
    expect(releasesBetween(r, '1.4', '1.5').map(x => x.tag)).toEqual(['v1.5.0', 'v1.5.2'])
  })

  it('rend vide si une version est illisible ou si rien ne sépare les deux', () => {
    expect(releasesBetween(all, 'latest', '1.5.0')).toEqual([])
    expect(releasesBetween(all, '1.5.0', '1.5.0')).toEqual([])
  })

  it('borne le nombre de releases en gardant les plus proches de la cible', () => {
    const many = Array.from({ length: 40 }, (_, i) => rel(`v2.${i}.0`))
    const out = releasesBetween(many, '2.0.0', '2.39.0')
    expect(out).toHaveLength(MAX_RELEASES)
    expect(out.at(-1)!.tag).toBe('v2.39.0')
  })
})

describe('nettoyage des notes', () => {
  it('retire commentaires HTML, images et badges, et compacte les lignes vides', () => {
    const lines = cleanNotes('## Notes\r\n<!-- brouillon -->\n![logo](http://x/y.png)\n[![ci](https://x/badge.svg)](https://x)\n\n\n\n- **Breaking** : `A` devient `B`  \n')
    expect(lines).toEqual(['## Notes', '', '- **Breaking** : `A` devient `B`'])
    expect(lines.join('\n')).not.toMatch(/<!--|!\[|badge/)
    expect(lines.join('\n')).toContain('**Breaking**')
  })

  it('tronque les notes trop longues et le signale', () => {
    const lines = cleanNotes('x'.repeat(MAX_NOTES_CHARS * 2))
    expect(lines.join('\n').length).toBeLessThan(MAX_NOTES_CHARS + 60)
    expect(lines.at(-1)).toBe('[… notes tronquées …]')
  })

  it('rend vide un texte vide', () => {
    expect(cleanNotes('')).toEqual([])
    expect(cleanNotes('<!-- seulement un commentaire -->')).toEqual([])
  })
})

describe('contexte du modèle', () => {
  it('décrit la mise à niveau, une part par release, les plus récentes pesant davantage', () => {
    const parts = releaseNotesParts({ image: 'postgres', service: 'db', from: '15.4', to: '16.1', repository: 'postgres/postgres', stateful: true, releases: [rel('v15.5'), rel('v16.1', '- migration requise')] })
    expect(parts[0]!.lines.join('\n')).toContain('mise à niveau de 15.4 vers 16.1')
    expect(parts[0]!.lines.join('\n')).toContain('service à données')
    expect(parts.slice(1).map(p => p.title)).toEqual(['Release v15.5 du 2026-10-01', 'Release v16.1 du 2026-10-01'])
    expect(parts[2]!.weight!).toBeGreaterThan(parts[1]!.weight!)
    expect(parts[2]!.lines).toEqual(['- migration requise'])
  })
})
