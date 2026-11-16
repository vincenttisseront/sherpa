/**
 * Fenêtres de déploiement d'un environnement : jours (1 = lundi … 7 = dimanche) et plage horaire locale (HH:MM, même jour)
 * dans un fuseau IANA. Fonctions pures, partagées entre le serveur (contrôle) et l'interface (information).
 */
export interface DeployWindow {
  days: number[]
  from: string
  to: string
}

const fmtCache = new Map<string, Intl.DateTimeFormat>()
function formatter(tz: string) {
  let f = fmtCache.get(tz)
  if (!f) {
    f = new Intl.DateTimeFormat('en-GB', { timeZone: tz, weekday: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
    fmtCache.set(tz, f)
  }
  return f
}
const WEEKDAY: Record<string, number> = { Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6, Sun: 7 }

/** Jour (1-7) et minutes depuis minuit à l'heure locale du fuseau. */
export function localParts(date: Date, tz: string): { day: number, minutes: number } {
  const parts = formatter(tz).formatToParts(date)
  const get = (t: string) => parts.find(p => p.type === t)?.value ?? ''
  return { day: WEEKDAY[get('weekday')] ?? 1, minutes: Number(get('hour')) * 60 + Number(get('minute')) }
}

const toMin = (hhmm: string) => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3, 5))

/** Sans fenêtre définie, le déploiement est possible à toute heure. */
export function isWindowOpen(windows: readonly DeployWindow[], tz: string, at: Date = new Date()): boolean {
  if (!windows.length) return true
  const { day, minutes } = localParts(at, tz)
  return windows.some(w => w.days.includes(day) && minutes >= toMin(w.from) && minutes < toMin(w.to))
}

/** Prochaine ouverture à partir de `from` (maintenant si ouverte) ; null sans ouverture dans les 8 jours. */
export function nextWindowOpening(windows: readonly DeployWindow[], tz: string, from: Date = new Date()): Date | null {
  if (!windows.length) return from
  const start = new Date(Math.ceil(from.getTime() / 60_000) * 60_000)
  for (let i = 0; i <= 8 * 24 * 60; i++) {
    const t = new Date(start.getTime() + i * 60_000)
    if (isWindowOpen(windows, tz, t)) return t
  }
  return null
}

export const DAY_LABEL = ['', 'lun', 'mar', 'mer', 'jeu', 'ven', 'sam', 'dim'] as const

export function describeWindows(windows: readonly DeployWindow[]): string {
  return windows.map(w => `${w.days.map(d => DAY_LABEL[d]).join(', ')} ${w.from}–${w.to}`).join(' ; ')
}
