/**
 * Healthchecks après déploiement (§8, §14) : attend que chaque service de la
 * stack ait un conteneur démarré et, s'il définit un healthcheck, « healthy ».
 * Échec rapide si un conteneur s'arrête, boucle en redémarrage ou devient
 * « unhealthy ». Pendant un délai de grâce initial, quelques redémarrages sont
 * tolérés : un service qui attend une dépendance (base, cœur applicatif)
 * redémarre souvent jusqu'à ce qu'elle réponde.
 * Résultat : HEALTHY, DEGRADED (une partie seulement) ou FAILED.
 */
import type { ContainerState, PortainerAdapter, PortainerConnection } from '../adapters/portainer'

export type ServiceHealth = 'healthy' | 'running' | 'starting' | 'unhealthy' | 'exited' | 'missing' | 'restarting'

export interface ServiceReport {
  service: string
  state: ServiceHealth
  detail: string
  containers: number
  logTail?: string[]
}

export interface HealthResult {
  outcome: 'HEALTHY' | 'DEGRADED' | 'FAILED'
  services: ServiceReport[]
  durationMs: number
}

const ok = (s: ServiceHealth) => s === 'healthy' || s === 'running'
const final = (s: ServiceHealth) => s === 'unhealthy' || s === 'exited' || s === 'restarting'

/** Délai de grâce maximal et nombre de redémarrages tolérés pendant ce délai. */
export const RESTART_GRACE_MS = 120_000
export const RESTART_GRACE_MAX = 10

export function classify(containers: ContainerState[], opts: { tolerateRestarts?: boolean, restartBaseline?: number } = {}): { state: ServiceHealth, detail: string } {
  if (!containers.length) return { state: 'missing', detail: 'Aucun conteneur créé' }
  const latest = containers.toSorted((a, b) => (b.startedAt ?? '').localeCompare(a.startedAt ?? ''))[0]!
  // Après la grâce, seuls les redémarrages survenus depuis comptent.
  const c = { ...latest, restartCount: Math.max(0, latest.restartCount - (opts.restartBaseline ?? 0)) }
  // Démarrage : redémarrages automatiques tolérés (dépendance pas encore prête), sans conclure ;
  // un conteneur de nouveau démarré est alors jugé sur son état et son healthcheck.
  const grace = opts.tolerateRestarts && c.restartCount < RESTART_GRACE_MAX
  const down = !c.running || c.status === 'restarting'
  if (grace && c.restartCount > 0 && down) return { state: 'starting', detail: `Redémarre (${c.restartCount}), en attente de ses dépendances` }
  if (c.restartCount >= 3 && down) return { state: 'restarting', detail: `Redémarre en boucle (${c.restartCount} redémarrages, code ${c.exitCode ?? '?'})` }
  if (!c.running) return { state: 'exited', detail: `Arrêté (${c.status}, code de sortie ${c.exitCode ?? '?'})` }
  if (c.restartCount >= 3 && !grace) return { state: 'restarting', detail: `Redémarre en boucle (${c.restartCount} redémarrages)` }
  if (c.health === 'unhealthy') return { state: 'unhealthy', detail: 'Healthcheck en échec' }
  if (c.health === 'starting') return { state: 'starting', detail: c.restartCount ? `Healthcheck en cours (après ${c.restartCount} redémarrage(s))` : 'Healthcheck en cours' }
  if (c.health === 'healthy') return { state: 'healthy', detail: 'Sain (healthcheck)' }
  return { state: 'running', detail: 'Démarré (pas de healthcheck)' }
}

export async function waitForStack(opts: {
  adapter: PortainerAdapter
  conn: PortainerConnection
  endpointId: number
  stackName: string
  services: string[]
  timeoutMs: number
  pollMs?: number
  /** Démarrés sans healthcheck : délai de stabilité avant de conclure. */
  settleMs?: number
  log: (message: string, level?: 'info' | 'warn' | 'error', service?: string) => Promise<void>
}): Promise<HealthResult> {
  const started = Date.now()
  const poll = opts.pollMs ?? 3000
  const settle = opts.settleMs ?? 5000
  const last = new Map<string, ServiceHealth>()
  const baseline = new Map<string, number>()
  let reports: ServiceReport[]
  let stableSince: number | null = null

  for (;;) {
    const containers = await opts.adapter.stackContainers(opts.conn, opts.endpointId, opts.stackName)
    // Grâce initiale bornée par le délai de la cible ; ses redémarrages servent ensuite de référence.
    const tolerateRestarts = Date.now() - started < Math.min(RESTART_GRACE_MS, opts.timeoutMs)
    reports = opts.services.map((service) => {
      const own = containers.filter(c => c.service === service)
      const restarts = Math.max(0, ...own.map(c => c.restartCount))
      if (tolerateRestarts) baseline.set(service, restarts)
      const { state, detail } = classify(own, { tolerateRestarts, restartBaseline: tolerateRestarts ? 0 : baseline.get(service) ?? 0 })
      return { service, state, detail, containers: own.length }
    })
    for (const r of reports) {
      if (last.get(r.service) !== r.state) {
        await opts.log(`${r.service} : ${r.detail}`, final(r.state) ? 'error' : 'info', r.service)
        last.set(r.service, r.state)
      }
    }

    const allOk = reports.every(r => ok(r.state))
    const anyFinal = reports.some(r => final(r.state))
    const elapsed = Date.now() - started
    if (allOk) {
      stableSince ??= Date.now()
      // Un conteneur sans healthcheck peut s'arrêter juste après son démarrage : on observe un court instant.
      if (reports.every(r => r.state === 'healthy') || Date.now() - stableSince >= settle) break
    }
    else {
      stableSince = null
    }
    if (anyFinal || elapsed >= opts.timeoutMs) break
    await new Promise(r => setTimeout(r, poll))
  }

  const failing = reports.filter(r => !ok(r.state))
  for (const r of failing) {
    const containers = await opts.adapter.stackContainers(opts.conn, opts.endpointId, opts.stackName)
    const c = containers.find(x => x.service === r.service)
    if (c) r.logTail = await opts.adapter.containerLogs(opts.conn, opts.endpointId, c.id, 30).catch(() => [])
    if (r.state === 'starting') r.detail = `Healthcheck non concluant après ${Math.round((Date.now() - started) / 1000)} s`
  }
  const outcome = failing.length === 0 ? 'HEALTHY' : failing.length === reports.length ? 'FAILED' : 'DEGRADED'
  return { outcome, services: reports, durationMs: Date.now() - started }
}
