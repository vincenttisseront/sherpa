/** Tableau de bord (§17) et état de santé observé des cibles. */

export interface TargetHealthState {
  checkedAt: string
  status: 'healthy' | 'degraded' | 'down' | 'unknown'
  failing: { service: string, state: string }[]
}

/** Image d'un service comparée à son registre : à jour, nouvelle version publiée, non vérifiable, locale ou figée. */
export type FreshnessState = 'current' | 'outdated' | 'unknown' | 'local' | 'pinned'

export interface TargetFreshness {
  targetId: string
  checkedAt: string
  services: { service: string, image: string, state: FreshnessState, detail: string, remoteDigest?: string }[]
  error: string | null
}

/** Ce qui tourne : une ligne par cible déployée (ou en cours de déploiement). */
export interface DeployedTarget {
  targetId: string
  projectId: string
  project: string
  environment: string
  isProduction: boolean
  server: string
  status: 'healthy' | 'degraded' | 'down' | 'stopped' | 'unknown' | 'deploying' | 'failed'
  failing: string[]
  release: { number: number, activatedAt: string | null, source: string } | null
  lastDeployment: { id: string, status: string, at: string } | null
  /** Images en service (abrégées), d'après la release active. */
  images: string[]
  /**
   * Accès publics : expositions gérées (port HTTPS réel du Traefik qui sert la cible),
   * puis routes détectées sur les reverse proxies de l'hôte vers les conteneurs de la stack.
   */
  links: { host: string, url: string, service: string | null, detected: boolean }[]
  watchtower: boolean
  /** Watchtower activé dans la configuration mais pas encore en place (appliqué au prochain déploiement). */
  watchtowerToApply: boolean
}

/** Ce qui reste à faire : action explicite sur une cible, ou situation détectée. */
export interface PendingItem {
  kind: 'action' | 'stopped' | 'failed' | 'never-deployed' | 'redeploy' | 'upload' | 'acme' | 'certificate' | 'networks' | 'image'
  severity: 'danger' | 'warning' | 'info'
  title: string
  detail: string | null
  link: string | null
  at: string | null
}

export interface DashboardDto {
  period: string
  tiles: {
    serversOnline: number
    serversTotal: number
    endpointsReachable: number
    endpointsTotal: number
    activeProjects: number
    deploymentsRunning: number
    deploymentsSucceeded: number
    deploymentsFailed: number
    buildsFailed: number
    degradedTargets: number
    unhealthyServices: number
    imageUpdates: number
  }
  deployed: DeployedTarget[]
  pending: PendingItem[]
  /** Watchtower : cibles déployées où il est actif. */
  watchtower: { enabled: number, toApply: number, deployed: number }
  degraded: { targetId: string, projectId: string, project: string, environment: string, status: string, failing: string[], checkedAt: string | null }[]
  recentActions: { id: string, at: string, actor: string, action: string, outcome: string, target: string | null }[]
  /** deploymentId : alerte d'un déploiement (acquittable s'il est en échec). */
  recentAlerts: { id: string, at: string, event: string, severity: string, title: string, link: string | null, deploymentId: string | null }[]
  imageUpdates: { id: string, at: string, project: string, projectId: string, environment: string, service: string, kind: string }[]
  /** Activité par jour sur la période (déploiements réussis / en échec). */
  activity: { day: string, succeeded: number, failed: number }[]
}
