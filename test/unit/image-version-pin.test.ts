import { describe, expect, it } from 'vitest'
import { latestVersion } from '../../shared/utils/image-version'

describe('version fixe d\'une image absente ou flottante', () => {
  it('dernière version pure publiée, la plus précise, hors préversions et variantes', () => {
    expect(latestVersion(['latest', '1.27', '1.27.3', '1.27.3-alpine', '1.28.0-rc1', '1.26.9', 'mainline'])).toBe('1.27.3')
    expect(latestVersion(['v2.4', 'v2.10.1', 'v2.10'])).toBe('v2.10.1')
    expect(latestVersion(['18', '17.6', '18-alpine', '17'])).toBe('18')
    expect(latestVersion(['latest', 'alpine', 'sha-0123456789abcdef'])).toBeNull()
    // n8n : tags datés à écarter.
    expect(latestVersion(['20230811', '1.123.91', '2.4.1', 'next'])).toBe('2.4.1')
  })
})
