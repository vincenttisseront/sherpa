import { describe, expect, it } from 'vitest'
import { byCode, byNumber } from '../../shared/utils/compare'
import { trimChars, trimEndChars, trimTrailingSlashes } from '../../shared/utils/trim'

describe('trim', () => {
  it('retire les « / » de fin comme /\\/+$/', () => {
    for (const s of ['', '/', '////', 'a', 'a/', 'a//b//', '/a/', 'https://x.test///', '//']) {
      expect(trimTrailingSlashes(s)).toBe(s.replace(/\/+$/, ''))
    }
  })
  it('retire un caractère donné en fin ou aux deux bords', () => {
    expect(trimEndChars('abc==', '=')).toBe('abc')
    expect(trimEndChars('===', '=')).toBe('')
    expect(trimChars('--a-b--', '-')).toBe('a-b')
    expect(trimChars('---', '-')).toBe('')
    expect(trimChars('/x/', '/')).toBe('x')
  })
  it('reste linéaire sur une longue suite de « / » suivie d\'un autre caractère', () => {
    const s = `${'/'.repeat(200_000)}x`
    const t0 = performance.now()
    expect(trimTrailingSlashes(s)).toBe(s)
    expect(performance.now() - t0).toBeLessThan(100)
  })
})

describe('compare', () => {
  it('byCode reproduit le tri par défaut des chaînes', () => {
    const words = ['b', 'B', 'a', 'é', 'Z', 'a-b', 'a_b', '10', '9']
    expect([...words].sort(byCode)).toEqual([...words].sort())
  })
  it('byNumber trie les nombres par valeur', () => {
    expect([10, 9, 2, 1].sort(byNumber)).toEqual([1, 2, 9, 10])
  })
})
