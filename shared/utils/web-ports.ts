/**
 * Port publié servant probablement du web (à placer derrière le reverse proxy) : port du
 * conteneur courant d'une application web, ou image / service évoquant un serveur web.
 */
const NOT_WEB = new Set([21, 22, 25, 53, 110, 143, 465, 587, 993, 995, 1025, 1433, 1521, 2375, 2376, 3306, 5432, 5672, 6379, 9042, 9092, 11211, 27017])
const WEB_PORTS = new Set([80, 3000, 3001, 4000, 4200, 5000, 5173, 8000, 8008, 8025, 8080, 8081, 8088, 8888, 9000, 9090])
const WEB_IMAGE = /nginx|caddy|httpd|apache|traefik|haproxy|node|nuxt|next|php|wordpress|grafana|kibana|mailpit|minio|garage|gitea|jenkins|keycloak|portal|admin|web|front/i

/** Port du conteneur d'une entrée « ports » (127.0.0.1:4080:80/tcp → 80). */
export const containerPortOf = (p: { entry: string, containerPort?: number }) => p.containerPort ?? Number(p.entry.split('/')[0]!.split(':').pop())

/** Raison affichée si le port publié sert probablement du web, sinon null. */
export function webHint(p: { service: string, entry: string, protocol: 'tcp' | 'udp', containerPort?: number }, image: string | undefined): string | null {
  const cp = containerPortOf(p)
  if (p.protocol !== 'tcp' || !Number.isFinite(cp) || NOT_WEB.has(cp) || cp === 443) return null
  if (WEB_PORTS.has(cp)) return `port ${cp} du conteneur`
  return WEB_IMAGE.test(`${image ?? ''} ${p.service}`) ? `image ${image || p.service}` : null
}

/** Domaine proposé d'après les domaines autorisés du proxy (*.exemple → service-stack.exemple). */
export function suggestWebHost(service: string, stack: string, allowedDomains: readonly string[]): string {
  const base = `${service}-${stack}`.toLowerCase().replace(/[^a-z0-9-]/g, '-')
  const wildcard = allowedDomains.find(x => x.startsWith('*.')) ?? null
  if (wildcard) return `${base}${wildcard.slice(1)}`
  return allowedDomains[0] ?? `${base}.localhost`
}

/** Port publié retiré (reverse proxy uniquement) ou republié ; exposition web ajoutée au passage si le service n'en a pas. */
export interface UnpublishRequest { service: string, published: number, protocol: 'tcp' | 'udp', unpublished: boolean, exposure?: { host: string, port: number } }
