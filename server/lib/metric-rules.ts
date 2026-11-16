/**
 * Évaluation des règles d'alerte de ressources sur les relevés d'un conteneur (fonction pure).
 * Une alerte exige un dépassement continu sur toute la durée (et une couverture suffisante de relevés :
 * pas d'alerte sur quelques points isolés ni juste après un démarrage).
 */
import type { MetricRule } from '../../shared/schemas/metrics'

export interface Sample {
  /** Millisecondes depuis epoch. */
  ts: number
  cpu: number | null
  memory: number | null
  memoryLimit: number | null
  restarts: number | null
}

export interface RuleResult { firing: boolean, value: number | null }

const mean = (v: number[]) => v.reduce((a, b) => a + b, 0) / v.length

export function memoryPercent(s: Pick<Sample, 'memory' | 'memoryLimit'>): number | null {
  return s.memory !== null && s.memoryLimit !== null && s.memoryLimit > 0 ? (s.memory / s.memoryLimit) * 100 : null
}

export function evaluateRule(rule: Pick<MetricRule, 'metric' | 'threshold' | 'minutes'>, samples: readonly Sample[], now: number): RuleResult {
  const from = now - rule.minutes * 60_000
  const win = samples.filter(s => s.ts >= from && s.ts <= now).sort((a, b) => a.ts - b.ts)
  if (rule.metric === 'restarts') {
    const counts = win.map(s => s.restarts).filter((n): n is number => n !== null)
    if (counts.length < 2) return { firing: false, value: null }
    // Compteur remis à zéro par une recréation du conteneur : seules les hausses comptent.
    let delta = 0
    for (let i = 1; i < counts.length; i++) delta += Math.max(0, counts[i]! - counts[i - 1]!)
    return { firing: delta >= rule.threshold, value: delta }
  }
  const values = win.map(s => (rule.metric === 'cpu' ? s.cpu : memoryPercent(s))).filter((n): n is number => n !== null)
  const needed = Math.max(2, Math.ceil(rule.minutes * 0.8))
  if (values.length < needed) return { firing: false, value: values.length ? mean(values) : null }
  return { firing: values.every(v => v >= rule.threshold), value: mean(values) }
}
