/**
 * Carte des reverse proxies d'un endpoint : proxies, points d'entrée et ports
 * de l'hôte, routes, conteneurs attachés, état des certificats ACME de chaque
 * Traefik, ports publiés hors proxy. Lecture seule ; les stockages ACME ne
 * livrent que domaines, émetteurs et dates.
 */
import type { ProxyTopology } from './proxy'
import type { DomainAcmeStateDto } from './managed-proxy'

export interface MapContainer {
  id: string
  name: string
  image: string
  stack: string | null
  service: string | null
  running: boolean
  state: string
  health: 'healthy' | 'unhealthy' | 'starting' | null
  managed: boolean
  /** Projet de la plateforme (label platform.project). */
  project: { id: string, name: string, environment: string | null } | null
  /** Réseaux partagés avec au moins un proxy. */
  proxyNetworks: string[]
  /** Ports publiés sur l'hôte. */
  hostPorts: { host: string, container: number, protocol: string }[]
  /** Ports TCP du conteneur (exposés ou publiés) : cibles possibles d'une route. */
  ports: number[]
}

export interface MapResolver {
  proxyId: string
  name: string
  challenge: 'http' | 'tls' | 'dns' | null
  dnsProvider: string | null
  staging: boolean
  storage: string | null
  /** Stockage lu : null si illisible ou absent (message dans error). */
  accountRegistered: boolean | null
  certificates: number
  error: string | null
}

export interface MapHostCertificate {
  proxyId: string
  host: string
  /** Résolveur ACME ; null : certificat fourni par fichier ou certificat par défaut. */
  resolver: string | null
  state: DomainAcmeStateDto | 'static'
  issuer: string | null
  notAfter: string | null
  staging: boolean
  error: string | null
}

export interface ProxyMapDto {
  topology: ProxyTopology
  containers: MapContainer[]
  resolvers: MapResolver[]
  certificates: MapHostCertificate[]
  /** Erreurs ACME récentes lues dans les logs de chaque Traefik. */
  acmeErrors: { proxyId: string, at: string | null, domains: string[], message: string }[]
}

export interface EndpointListItem {
  id: string
  name: string
  serverId: string
  serverName: string
}
