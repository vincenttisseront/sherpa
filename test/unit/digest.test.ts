import { describe, expect, it } from 'vitest'
import { composeDigest, digestDue, lastScheduled } from '../../server/lib/digest'

// Novembre 2026 : heure d'hiver à Paris (UTC+1). Lundi 9, mardi 10.
const at = (day: number, hhmm: string) => new Date(`2026-11-${String(day).padStart(2, '0')}T${hhmm}:00+01:00`)

describe('échéance des résumés', () => {
  it('quotidien : dernière échéance à l\'heure choisie (heure de Paris)', () => {
    expect(lastScheduled({ digest: 'daily', digestHour: 8 }, at(10, '09:30'))?.toISOString()).toBe(at(10, '08:00').toISOString())
    expect(lastScheduled({ digest: 'daily', digestHour: 8 }, at(10, '07:59'))?.toISOString()).toBe(at(9, '08:00').toISOString())
  })
  it('hebdomadaire : le lundi', () => {
    expect(lastScheduled({ digest: 'weekly', digestHour: 8 }, at(13, '12:00'))?.toISOString()).toBe(at(9, '08:00').toISOString())
  })
  it('désactivé : jamais', () => {
    expect(lastScheduled({ digest: 'off', digestHour: 8 }, at(10, '09:30'))).toBeNull()
  })
  it('dû une seule fois par échéance', () => {
    const s = { digest: 'daily', digestHour: 8 }
    const boundary = digestDue(s, at(9, '10:00'), at(10, '08:05'))
    expect(boundary?.toISOString()).toBe(at(10, '08:00').toISOString())
    expect(digestDue(s, boundary!, at(10, '08:20'))).toBeNull()
    expect(digestDue(s, at(10, '08:01'), at(10, '09:00'))).toBeNull()
  })
})

describe('composition du résumé', () => {
  const e = (event: string, severity: string, title: string, min: number) => ({ event, severity, title, createdAt: new Date(at(10, '07:00').getTime() - min * 60_000) })
  it('rien à résumer : pas de message', () => {
    expect(composeDigest([], 'daily', at(9, '08:00'), at(10, '08:00'))).toBeNull()
  })
  it('gravité maximale, décompte par type et pires évènements en tête', () => {
    const r = composeDigest([e('deployment.succeeded', 'info', 'Déploiement A réussi', 5), e('deployment.failed', 'error', 'Échec B', 10), e('deployment.failed', 'error', 'Échec C', 1), e('resource.alert', 'warning', 'CPU élevé : x', 3)], 'daily', at(9, '08:00'), at(10, '08:00'))!
    expect(r.severity).toBe('error')
    expect(r.title).toBe('Résumé quotidien — 4 évènements')
    expect(r.facts[0]).toEqual({ label: 'Échec de déploiement', value: '2' })
    expect(r.summary).toContain('2 erreur(s), 1 alerte(s), 1 information(s)')
    expect(r.summary.indexOf('Échec C')).toBeLessThan(r.summary.indexOf('Déploiement A réussi'))
  })
  it('tronque la liste au-delà de huit évènements', () => {
    const many = Array.from({ length: 12 }, (_, i) => e('deployment.succeeded', 'info', `OK ${i}`, i))
    expect(composeDigest(many, 'weekly', at(3, '08:00'), at(10, '08:00'))!.summary).toContain('… et 4 autre(s)')
  })
})
