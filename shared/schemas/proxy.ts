/**
 * Reverse proxies réellement en place sur un endpoint (lecture seule) :
 * configuration statique de Traefik, routes, TLS, réseaux, et autres proxies.
 * Extraction par liste blanche : aucun secret (e-mail ACME, jetons DNS,
 * utilisateurs basic auth, clés) n'est lu au-delà de la mémoire du serveur.
 */

export type ProxyKind = 'traefik' | 'caddy' | 'caddy-docker-proxy' | 'nginx' | 'nginx-proxy' | 'nginx-proxy-manager' | 'haproxy' | 'envoy' | 'swag' | 'httpd'

export interface TraefikEntrypoint {
  name: string
  address: string | null
  port: number | null
  protocol: 'tcp' | 'udp'
  /** Redirection automatique vers un autre point d'entrée (HTTP → HTTPS). */
  redirectTo: string | null
  /** TLS activé pour toutes les routes du point d'entrée. */
  tls: boolean
  certResolver: string | null
  middlewares: string[]
  /** Port publié sur l'hôte (via Docker), si connu. */
  hostPorts: string[]
}

export interface TraefikCertResolver {
  name: string
  challenge: 'http' | 'tls' | 'dns' | null
  /** Fournisseur DNS (dnsChallenge), sans ses identifiants. */
  dnsProvider: string | null
  httpEntrypoint: string | null
  /** Autorité ACME de test (staging). */
  staging: boolean
  storage: string | null
}

export interface TraefikStatic {
  /** Source effective : Traefik n'en utilise qu'une (fichier, sinon arguments, sinon variables). */
  source: 'file' | 'cli' | 'env' | 'defaults'
  configFile: string | null
  entrypoints: TraefikEntrypoint[]
  certResolvers: TraefikCertResolver[]
  providers: {
    docker: { enabled: boolean, exposedByDefault: boolean, network: string | null, defaultRule: string | null, constraints: string | null } | null
    swarm: boolean
    file: { filename: string | null, directory: string | null, watch: boolean } | null
    other: string[]
  }
  api: { dashboard: boolean, insecure: boolean }
  accessLog: boolean
  metrics: string[]
  warnings: string[]
}

export interface TlsOptionInfo {
  name: string
  minVersion: string | null
  maxVersion: string | null
  sniStrict: boolean
  cipherSuites: number
  clientAuth: string | null
}

export interface ProxyRoute {
  /** Routeur Traefik (nom@fournisseur) ou bloc de site pour les autres proxies. */
  router: string
  /** Conteneur du proxy qui sert la route. */
  proxyId: string
  provider: 'docker' | 'file' | 'caddyfile' | 'nginx' | 'caddy-labels'
  kind: 'http' | 'tcp' | 'udp'
  rule: string | null
  hosts: string[]
  pathPrefix: string | null
  entrypoints: string[]
  /** TLS effectif (routeur ou point d'entrée). */
  tls: boolean
  certResolver: string | null
  tlsOptions: string | null
  passthrough: boolean
  /** Redirection HTTP → HTTPS appliquée à cette route. */
  redirectsToHttps: boolean
  middlewares: string[]
  service: string | null
  /** Destination : conteneur et port. */
  container: { id: string, name: string, stack: string | null, service: string | null, managed: boolean } | null
  targetPort: number | null
  targetUrl: string | null
  network: string | null
  /** Règle simple (Host + PathPrefix) convertible en exposition gérée par la plateforme. */
  convertible: boolean
  /** Conteneur absent du réseau par lequel Traefik doit le joindre : réseau à rejoindre (réparation proposée). */
  reattach?: { network: string, reason: string } | null
  warnings: string[]
}

export interface NginxListen {
  port: number
  tls: boolean
  /** Écoute qui redirige vers HTTPS (« :443 »). */
  redirectTo: string | null
  hostPorts: string[]
}

export interface NginxStatic {
  /** Reverse proxy des projets déclaré dans la plateforme : sites écrits par la console. */
  managed: { provider: 'nginx' | 'nginx-proxy', confDir: string | null, certsDir: string, acme: boolean, network: string } | null
  listens: NginxListen[]
  /** Sites (blocs server ou VIRTUAL_HOST) lus, dont ceux écrits par la console. */
  sites: number
  platformSites: number
  /** Certificats référencés par la configuration (ssl_certificate). */
  certificateFiles: number
}

export interface DetectedProxy {
  kind: ProxyKind
  container: { id: string, name: string, image: string, stack: string | null, running: boolean }
  version: string | null
  networks: string[]
  hostPorts: { container: number, host: string, protocol: string }[]
  /** Traefik uniquement. */
  traefik: TraefikStatic | null
  /** nginx, nginx-proxy, SWAG : écoutes, sites, gestion par la plateforme. */
  nginx?: NginxStatic | null
  tlsOptions: TlsOptionInfo[]
  certificates: { files: number, defaultCertificate: boolean }
  /** Fichiers de configuration lus (chemins dans le conteneur, jamais leur contenu). */
  configFiles: string[]
  /** Proxies autres que Traefik : signalés, routes indicatives. */
  managedByPlatform: boolean
  warnings: string[]
}

export interface ProxyTopology {
  endpointId: string
  scannedAt: string
  proxies: DetectedProxy[]
  routes: ProxyRoute[]
  /** Middlewares déclarés (nom@fournisseur → type), sans leur configuration. */
  middlewares: { name: string, type: string, provider: string }[]
  warnings: string[]
}

export interface TraefikSuggestion {
  available: boolean
  config: {
    networkName: string
    certResolver: string | null
    entrypointHttp: string
    entrypointHttps: string
    allowedDomains: string[]
    defaultMiddlewares: string[]
    routerNamePattern: string
    exposure: 'internal' | 'external'
    redirectToHttps: boolean
    /** Techno pilotée (absente : Traefik). */
    provider?: 'traefik' | 'nginx-proxy' | 'nginx'
    nginxContainer?: string | null
    nginxConfDir?: string
    letsencrypt?: boolean
  } | null
  /** Justification par champ. */
  notes: Record<string, string>
  warnings: string[]
  /** Conteneurs candidats (proxy reconnu ou publiant 80/443), le retenu en premier. */
  candidates?: ProxyCandidate[]
}

export interface ProxyCandidate {
  container: string
  image: string
  running: boolean
  /** Techno reconnue (image, ou configuration trouvée dans le conteneur), null : inconnue. */
  kind: ProxyKind | null
  /** Techno que la console peut piloter pour ce conteneur ; null : non prise en charge. */
  provider: 'traefik' | 'nginx-proxy' | 'nginx' | null
  ports: string[]
  reason: string
  selected: boolean
}
