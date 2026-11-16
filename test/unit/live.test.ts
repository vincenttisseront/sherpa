import { describe, expect, it } from 'vitest'
import { healthOf } from '../../server/services/live'
import { displayImage, fmtBytesShort, fmtRelative } from '../../app/utils/status'

describe('vue en direct', () => {
  it('santé déduite du libellé Docker', () => {
    expect(healthOf('Up 3 hours (healthy)')).toBe('healthy')
    expect(healthOf('Up 2 minutes (unhealthy)')).toBe('unhealthy')
    expect(healthOf('Up 5 seconds (health: starting)')).toBe('starting')
    expect(healthOf('Up 3 days')).toBeNull()
    expect(healthOf('Exited (1) 2 hours ago')).toBeNull()
  })
  it('images lisibles, tailles et durées relatives', () => {
    expect(displayImage('sha256:1b42d1fd9b1747cbeb9ac7382e0fbfa8')).toBe('image locale 1b42d1fd9b17')
    expect(displayImage(`postgres:16@sha256:${'a'.repeat(64)}`)).toBe('postgres:16 (empreinte figée)')
    expect(displayImage('nginx:1.27')).toBe('nginx:1.27')
    expect(fmtBytesShort(8 * 1024 ** 3)).toBe('8.0 Go')
    expect(fmtBytesShort(512)).toBe('512 o')
    const now = Date.parse('2026-10-09T10:00:00Z')
    expect(fmtRelative('2026-10-09T09:57:00Z', now)).toBe('il y a 3 min')
    expect(fmtRelative('2026-10-08T10:00:00Z', now)).toBe('il y a 1 j')
  })
})
