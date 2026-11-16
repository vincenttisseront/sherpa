/**
 * Contrôle des ports publiés (§10).
 * Ordre de priorité : interdit > soumis à validation > autorisé.
 * Un port sans règle est « soumis à validation » : il exige une justification
 * et une confirmation explicite.
 */
export type PortPolicy = 'allowed' | 'approval' | 'forbidden'
export type Protocol = 'tcp' | 'udp'

export interface PortRuleLike {
  portFrom: number
  portTo: number
  protocol: Protocol
  policy: PortPolicy
  description?: string | null
}

/** Ports interdits par défaut, quelle que soit la configuration (§10). */
export const DEFAULT_FORBIDDEN_PORTS: readonly PortRuleLike[] = [
  { portFrom: 22, portTo: 22, protocol: 'tcp', policy: 'forbidden', description: 'SSH' },
  { portFrom: 2375, portTo: 2377, protocol: 'tcp', policy: 'forbidden', description: 'Docker API / Swarm' },
  { portFrom: 5432, portTo: 5432, protocol: 'tcp', policy: 'forbidden', description: 'PostgreSQL' },
  { portFrom: 6379, portTo: 6379, protocol: 'tcp', policy: 'forbidden', description: 'Redis' },
  { portFrom: 9001, portTo: 9001, protocol: 'tcp', policy: 'forbidden', description: 'Portainer Agent' },
]

export interface PortRequest {
  hostPort: number
  containerPort: number
  protocol: Protocol
  hostIp?: string
  justification?: string
  confirmed?: boolean
}

export interface PortDecision {
  policy: PortPolicy
  accepted: boolean
  reason: string
  rule?: PortRuleLike
}

function matches(rule: PortRuleLike, port: number, protocol: Protocol): boolean {
  return rule.protocol === protocol && port >= rule.portFrom && port <= rule.portTo
}

export function evaluatePort(req: PortRequest, rules: readonly PortRuleLike[]): PortDecision {
  for (const p of [req.hostPort, req.containerPort]) {
    if (!Number.isInteger(p) || p < 1 || p > 65535) {
      return { policy: 'forbidden', accepted: false, reason: `Port invalide : ${p}` }
    }
  }
  if (req.hostIp !== undefined && !/^(?:\d{1,3}\.){3}\d{1,3}$|^\[?[0-9a-f:]+\]?$/i.test(req.hostIp)) {
    return { policy: 'forbidden', accepted: false, reason: `IP d'écoute invalide : ${req.hostIp}` }
  }

  const all = [...DEFAULT_FORBIDDEN_PORTS, ...rules].filter(r => matches(r, req.hostPort, req.protocol))
  const pick = (policy: PortPolicy) => all.find(r => r.policy === policy)

  const forbidden = pick('forbidden')
  if (forbidden) {
    return { policy: 'forbidden', accepted: false, reason: `Port ${req.hostPort}/${req.protocol} interdit${forbidden.description ? ` (${forbidden.description})` : ''}`, rule: forbidden }
  }
  const approval = pick('approval')
  const allowed = pick('allowed')
  if (!approval && allowed) {
    return { policy: 'allowed', accepted: true, reason: 'Port autorisé', rule: allowed }
  }
  const rule = approval
  const justified = (req.justification?.trim().length ?? 0) >= 10
  if (!justified) {
    return { policy: 'approval', accepted: false, reason: 'Port custom : justification requise (10 caractères minimum)', rule }
  }
  if (!req.confirmed) {
    return { policy: 'approval', accepted: false, reason: 'Port custom : confirmation explicite requise', rule }
  }
  return { policy: 'approval', accepted: true, reason: 'Port custom justifié et confirmé', rule }
}
