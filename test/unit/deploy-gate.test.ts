import { describe, expect, it } from 'vitest'
import { decideGate } from '../../server/lib/deploy-gate'
import { type DeployWindow, describeWindows, isWindowOpen, nextWindowOpening } from '../../shared/utils/deploy-windows'

const TZ = 'Europe/Paris'
const office: DeployWindow[] = [{ days: [1, 2, 3, 4], from: '09:00', to: '17:00' }]
// Novembre 2026 (heure d'hiver, UTC+1) : lundi 9 = jour 1.
const at = (day: number, hhmm: string) => new Date(`2026-11-${String(day).padStart(2, '0')}T${hhmm}:00+01:00`)

describe('fenêtres de déploiement', () => {
  it('sans fenêtre, toujours ouvert', () => {
    expect(isWindowOpen([], TZ, at(14, '03:00'))).toBe(true)
  })
  it('ouvre en semaine dans la plage, pas en dehors', () => {
    expect(isWindowOpen(office, TZ, at(9, '09:00'))).toBe(true)
    expect(isWindowOpen(office, TZ, at(9, '16:59'))).toBe(true)
    expect(isWindowOpen(office, TZ, at(9, '17:00'))).toBe(false)
    expect(isWindowOpen(office, TZ, at(9, '08:59'))).toBe(false)
    expect(isWindowOpen(office, TZ, at(13, '10:00'))).toBe(false) // vendredi
    expect(isWindowOpen(office, TZ, at(14, '10:00'))).toBe(false) // samedi
  })
  it('lit l\'heure dans le fuseau demandé', () => {
    // 09:30 à Paris = 08:30 UTC ; en UTC la fenêtre 09:00 n'est pas encore ouverte.
    expect(isWindowOpen(office, 'UTC', at(9, '09:30'))).toBe(false)
    expect(isWindowOpen(office, TZ, at(9, '09:30'))).toBe(true)
  })
  it('trouve la prochaine ouverture (vendredi soir → lundi 09:00)', () => {
    expect(nextWindowOpening(office, TZ, at(13, '18:00'))?.toISOString()).toBe(at(16, '09:00').toISOString())
    expect(nextWindowOpening(office, TZ, at(9, '10:00'))?.toISOString()).toBe(at(9, '10:00').toISOString())
  })
  it('décrit les fenêtres', () => {
    expect(describeWindows(office)).toBe('lun, mar, mer, jeu 09:00–17:00')
  })
})

describe('porte de déploiement', () => {
  const open = at(10, '10:00')
  const closed = at(14, '10:00')
  const base = { action: 'deploy', requestedBy: 'u1', scheduledAt: null, urgent: false }
  const free = { requireApproval: false, timezone: TZ, windows: [] as DeployWindow[] }

  it('exécute tout de suite sans règle', () => {
    expect(decideGate(free, { ...base, now: open })).toEqual({ kind: 'run' })
  })
  it('ne soumet pas les actions d\'exploitation courante', () => {
    expect(decideGate({ requireApproval: true, timezone: TZ, windows: office }, { ...base, action: 'restart', now: closed })).toEqual({ kind: 'run' })
    expect(decideGate({ requireApproval: true, timezone: TZ, windows: office }, { ...base, action: 'stop', now: closed })).toEqual({ kind: 'run' })
  })
  it('met en attente de validation', () => {
    expect(decideGate({ ...free, requireApproval: true }, { ...base, now: open })).toEqual({ kind: 'hold', reason: 'policy', at: null })
  })
  it('refuse hors fenêtre, sauf urgence (validation) ou planification', () => {
    const p = { ...free, windows: office }
    expect(decideGate(p, { ...base, now: closed })).toMatchObject({ kind: 'refuse', status: 409 })
    expect(decideGate(p, { ...base, now: closed, urgent: true })).toEqual({ kind: 'hold', reason: 'urgent', at: null })
    const later = at(16, '10:00')
    expect(decideGate(p, { ...base, now: closed, scheduledAt: later })).toEqual({ kind: 'schedule', at: later })
  })
  it('refuse une planification passée, trop lointaine ou hors fenêtre', () => {
    const p = { ...free, windows: office }
    expect(decideGate(p, { ...base, now: open, scheduledAt: at(10, '08:00') })).toMatchObject({ kind: 'refuse', status: 422 })
    expect(decideGate(p, { ...base, now: open, scheduledAt: at(14, '10:00') })).toMatchObject({ kind: 'refuse', status: 422, message: expect.stringContaining('hors') })
    expect(decideGate(free, { ...base, now: open, scheduledAt: new Date(open.getTime() + 40 * 86_400_000) })).toMatchObject({ kind: 'refuse', status: 422 })
  })
  it('une planification soumise à validation attend l\'accord avant d\'être programmée', () => {
    const when = at(11, '10:00')
    expect(decideGate({ ...free, requireApproval: true }, { ...base, now: open, scheduledAt: when })).toEqual({ kind: 'hold', reason: 'policy', at: when })
  })
  it('un automatisme hors fenêtre est reporté à la prochaine ouverture', () => {
    const r = decideGate({ ...free, windows: office }, { ...base, requestedBy: null, now: at(13, '18:00') })
    expect(r).toEqual({ kind: 'schedule', at: at(16, '09:00'), automatic: true })
  })
})
