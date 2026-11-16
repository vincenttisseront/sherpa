/** Résultat de l'analyse d'un Compose (§9), partagé entre l'API et l'interface. */
export type Severity = 'error' | 'warning' | 'info'

export interface ComposeIssue {
  severity: Severity
  code: string
  service?: string
  message: string
  /** Image introuvable : image analysée et sources équivalentes vérifiées (à choisir avant de déployer). */
  image?: string
  alternatives?: string[]
}

export interface PortApproval {
  service: string
  published: number
  protocol: 'tcp' | 'udp'
  justification: string
  confirmed: boolean
}

export interface BuildPlan {
  service: string
  /** Contexte relatif à la racine des sources. */
  context: string
  /** Dockerfile relatif au contexte. */
  dockerfile: string
  args: Record<string, string>
  target: string | null
  image: string
}

export interface PortReport {
  service: string
  entry: string
  published: number | null
  hostIp: string | null
  protocol: 'tcp' | 'udp'
  policy: 'allowed' | 'approval' | 'forbidden' | 'internal'
  accepted: boolean
  reason: string
  needsApproval: boolean
  /** Port du conteneur (détection d'un service web). */
  containerPort?: number
  /** Retiré du Compose déployé : accès par le reverse proxy uniquement (réglage de la cible). */
  unpublished?: boolean
}

export interface MountReport {
  service: string
  type: string
  source: string | null
  /** Source après réécriture (binds relatifs → répertoire runtime du projet). */
  effectiveSource: string | null
  target: string
  readOnly: boolean
  accepted: boolean
  reason: string
}

export interface Change {
  service?: string
  kind: 'image' | 'build' | 'label' | 'volume' | 'restart' | 'container_name' | 'pull_policy' | 'removed' | 'variable' | 'network' | 'healthcheck' | 'port'
  message: string
}

export interface AnalysisResult {
  ok: boolean
  stackName: string
  issues: ComposeIssue[]
  services: string[]
  builds: BuildPlan[]
  images: Record<string, string>
  ports: PortReport[]
  mounts: MountReport[]
  networks: { name: string, external: boolean, status: 'allowed' | 'created' | 'refused', reason: string }[]
  variables: { name: string, hasDefault: boolean, required: boolean, provided: boolean, secret: boolean }[]
  changes: Change[]
  sourceYaml: string
  finalYaml: string | null
  diff: string | null
  /** Variables secrètes transmises à Docker Compose par l'environnement (noms uniquement). */
  secretVariables: string[]
  exposures: ExposureReport[]
  /** Politique Watchtower par service (vide si Watchtower désactivé). */
  watchtower: { service: string, policy: 'off' | 'monitor' | 'update', accepted: boolean, reason: string }[]
}

/** Exposition d'un service par le Traefik de l'endpoint. */
export interface Exposure {
  service: string
  host: string
  port: number
  pathPrefix: string | null
  middlewares: string[]
}

/** Configuration Traefik effective de l'endpoint pour l'environnement. */
export interface TraefikPolicy {
  networkName: string
  certResolver: string | null
  entrypointHttp: string
  entrypointHttps: string
  allowedDomains: string[]
  defaultMiddlewares: string[]
  routerNamePattern: string
  exposure: 'internal' | 'external'
  redirectToHttps: boolean
  /** Reverse proxy de l'endpoint (Traefik par défaut). */
  provider?: 'traefik' | 'nginx-proxy' | 'nginx'
  /** nginx-proxy : certificats Let's Encrypt (LETSENCRYPT_HOST pour acme-companion). */
  letsencrypt?: boolean
}

export interface ExposureReport extends Exposure {
  router: string
  url: string
  accepted: boolean
  reason: string
}
