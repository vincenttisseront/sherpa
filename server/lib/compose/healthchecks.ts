/**
 * Healthchecks d'un Compose : réglages propres à la cible (délai de démarrage,
 * nombre d'essais…) appliqués à la release, et repérage des services dont
 * d'autres attendent l'état « sain » avec un délai de grâce court (premier
 * démarrage avec migrations : le service est déclaré en échec avant d'être prêt
 * et `docker compose up` s'arrête).
 */
import type { HealthcheckOverride } from '../../../shared/schemas/projects'
import type { Change, ComposeIssue } from '../../../shared/schemas/analysis'

type Obj = Record<string, unknown>
const isObj = (v: unknown): v is Obj => !!v && typeof v === 'object' && !Array.isArray(v)

/** Valeurs par défaut de Docker. */
const DEFAULTS = { interval: 30, retries: 3, startPeriod: 0 }
/** En deçà, un premier démarrage long (migrations) risque d'être déclaré en échec. */
export const SHORT_GRACE_SEC = 180

const UNITS: Record<string, number> = { h: 3600, m: 60, s: 1, ms: 0.001, us: 0.000001, µs: 0.000001, ns: 1e-9 }

/** Durée Compose (« 1m30s », « 90s », nombre de secondes) en secondes ; null si illisible. */
export function parseDurationSec(v: unknown): number | null {
  if (typeof v === 'number' && Number.isFinite(v)) return v
  if (typeof v !== 'string' || !v.trim()) return null
  const re = /(\d+(?:\.\d+)?)(h|ms|us|µs|ns|m|s)/g
  let total = 0
  let consumed = 0
  for (const m of v.trim().matchAll(re)) {
    total += Number(m[1]) * UNITS[m[2]!]!
    consumed += m[0].length
  }
  return consumed === v.trim().length ? total : null
}

const enabled = (hc: unknown): hc is Obj => isObj(hc) && hc.disable !== true && !(Array.isArray(hc.test) && hc.test[0] === 'NONE')

/** Délai avant qu'un service en démarrage soit déclaré en échec : start_period + interval × retries. */
export function graceSec(hc: Obj): number {
  const interval = parseDurationSec(hc.interval) ?? DEFAULTS.interval
  const retries = typeof hc.retries === 'number' ? hc.retries : DEFAULTS.retries
  return (parseDurationSec(hc.start_period) ?? DEFAULTS.startPeriod) + interval * retries
}

export function applyHealthOverrides(services: Record<string, Obj>, overrides: Record<string, HealthcheckOverride> | undefined): { changes: Change[], issues: ComposeIssue[] } {
  const changes: Change[] = []
  const issues: ComposeIssue[] = []
  for (const [name, o] of Object.entries(overrides ?? {})) {
    const svc = services[name]
    if (!svc) {
      issues.push({ severity: 'warning', code: 'healthcheck.override_unknown', message: `Réglage de healthcheck pour « ${name} » ignoré : service absent du Compose`, service: name })
      continue
    }
    if (!enabled(svc.healthcheck)) {
      issues.push({ severity: 'warning', code: 'healthcheck.override_none', message: 'Réglage de healthcheck ignoré : le service n\'a pas de healthcheck', service: name })
      continue
    }
    const hc = svc.healthcheck
    const set: string[] = []
    if (o.startPeriodSec !== undefined) {
      hc.start_period = `${o.startPeriodSec}s`
      set.push(`start_period ${o.startPeriodSec}s`)
    }
    if (o.intervalSec !== undefined) {
      hc.interval = `${o.intervalSec}s`
      set.push(`interval ${o.intervalSec}s`)
    }
    if (o.timeoutSec !== undefined) {
      hc.timeout = `${o.timeoutSec}s`
      set.push(`timeout ${o.timeoutSec}s`)
    }
    if (o.retries !== undefined) {
      hc.retries = o.retries
      set.push(`retries ${o.retries}`)
    }
    if (set.length) changes.push({ service: name, kind: 'healthcheck', message: `Healthcheck ajusté (réglage de la cible) : ${set.join(', ')}` })
  }
  return { changes, issues }
}

/** Services attendus « sains » par d'autres (depends_on condition: service_healthy) avec un délai de grâce court. */
export function shortGraceDependencies(services: Record<string, Obj>): { service: string, dependents: string[], graceSec: number }[] {
  const waited = new Map<string, string[]>()
  for (const [name, svc] of Object.entries(services)) {
    if (!isObj(svc.depends_on)) continue
    for (const [dep, cond] of Object.entries(svc.depends_on)) {
      if (isObj(cond) && cond.condition === 'service_healthy') waited.set(dep, [...(waited.get(dep) ?? []), name])
    }
  }
  const out: { service: string, dependents: string[], graceSec: number }[] = []
  for (const [service, dependents] of waited) {
    const hc = services[service]?.healthcheck
    if (!enabled(hc)) continue
    const g = graceSec(hc)
    if (g < SHORT_GRACE_SEC) out.push({ service, dependents, graceSec: Math.round(g) })
  }
  return out
}
