/**
 * Carte des reverse proxies d'un endpoint (lecture seule) : topologie des
 * proxies et routes, conteneurs attachés à leurs réseaux, certificats ACME de
 * chaque Traefik (stockage acme.json et erreurs des logs). Le stockage ACME est
 * lu en mémoire : seuls domaines, émetteurs et dates en sortent, jamais les clés.
 */
import { posix } from 'node:path'
import { eq, inArray } from 'drizzle-orm'
import type { MapContainer, MapHostCertificate, MapResolver, ProxyMapDto } from '../../shared/schemas/proxy-map'
import { portainer } from '../adapters/portainer'
import { db, schema } from '../db/client'
import { type AcmeCertificate, type AcmeLogError, domainState, parseAcmeLogs, parseAcmeStore } from '../lib/proxy/acme'
import { type Progress, noProgress } from '../utils/progress'
import { redactPatterns } from '../utils/redact'
import { type EndpointRow, healthOf } from './live'
import { endpointTopology } from './proxy'
import { certificateCovers } from '../lib/proxy/certificates'
import { MANAGED_PROXY_STACK } from '../../shared/schemas/managed-proxy'
import { listCertificates } from './proxy-certificates'
import { pickCertificate } from '../lib/proxy/nginx-sites'
import { DNS_PROVIDER_LABEL } from '../../shared/schemas/dns'
import { connectionFor } from './servers'

const TTL_MS = 30_000
const ACME_LIMITS = { maxBytes: 4 * 1024 * 1024, maxFiles: 1 }
const SYSTEM_NETWORKS = new Set(['bridge', 'host', 'none'])
const cache = new Map<string, { at: number, value: Promise<ProxyMapDto> }>()

const errMsg = (err: unknown) => redactPatterns((err as Error).message ?? String(err)).slice(0, 200)

async function build(row: EndpointRow, refresh: boolean, progress: Progress): Promise<ProxyMapDto> {
  const topology = await endpointTopology(row, { refresh, progress })
  const conn = await connectionFor(row.server)
  const p = portainer()
  const epId = row.ep.portainerEndpointId
  const raw = await p.listContainers(conn, epId)
  const proxyIds = new Set(topology.proxies.map(x => x.container.id))
  const proxyNets = new Set(topology.proxies.flatMap(x => x.networks))
  const routed = new Set(topology.routes.map(r => r.container?.id).filter(Boolean))

  // Projets de la plateforme désignés par les labels.
  const slugs = [...new Set(raw.map(c => c.labels['platform.project']).filter((s): s is string => !!s))]
  const projects = slugs.length ? await db().select({ id: schema.projects.id, slug: schema.projects.slug, name: schema.projects.name }).from(schema.projects).where(inArray(schema.projects.slug, slugs)) : []

  const containers: MapContainer[] = raw
    .filter(c => !proxyIds.has(c.id))
    .map((c) => {
      const hostPorts = (c.ports ?? []).filter(x => x.publicPort).map(x => ({ host: `${x.ip && x.ip !== '0.0.0.0' && x.ip !== '::' ? x.ip : '0.0.0.0'}:${x.publicPort}`, container: x.privatePort, protocol: x.type }))
      const pr = projects.find(x => x.slug === c.labels['platform.project'])
      return {
        id: c.id,
        name: c.names[0] ?? c.id.slice(0, 12),
        image: c.image,
        stack: c.labels['com.docker.compose.project'] ?? null,
        service: c.labels['com.docker.compose.service'] ?? null,
        running: c.state === 'running',
        state: c.state,
        health: healthOf(c.status),
        managed: c.labels['platform.managed'] === 'true',
        project: pr ? { id: pr.id, name: pr.name, environment: c.labels['platform.environment'] ?? null } : null,
        proxyNetworks: c.networks.filter(n => !SYSTEM_NETWORKS.has(n) && proxyNets.has(n)),
        hostPorts: [...new Map(hostPorts.map(h => [`${h.host}/${h.protocol}`, h])).values()],
        ports: [...new Set((c.ports ?? []).filter(x => x.type === 'tcp').map(x => x.privatePort))].sort((a, b) => a - b),
      }
    })
    // Conteneurs routés, attachés à un réseau de proxy ou publiant des ports.
    .filter(c => routed.has(c.id) || c.proxyNetworks.length || c.hostPorts.length)

  await progress.step('Lecture des certificats ACME')
  const resolvers: MapResolver[] = []
  const certificates: MapHostCertificate[] = []
  const acmeErrors: ProxyMapDto['acmeErrors'] = []
  for (const proxy of topology.proxies) {
    const routes = topology.routes.filter(r => r.proxyId === proxy.container.id && r.tls && !r.passthrough)
    const st = proxy.traefik
    const certsByResolver = new Map<string, AcmeCertificate[]>()
    let errors: AcmeLogError[] = []
    if (st?.certResolvers.length) {
      if (proxy.container.running) {
        const logs = await p.containerLogs(conn, epId, proxy.container.id, 500).catch(() => [] as string[])
        errors = parseAcmeLogs(logs)
        acmeErrors.push(...errors.slice(-10).map(e => ({ proxyId: proxy.container.id, ...e })))
      }
      // Un même fichier peut servir plusieurs résolveurs : lu une fois.
      const files = new Map<string, Promise<string | Error>>()
      for (const r of st.certResolvers) {
        const storage = r.storage ?? 'acme.json'
        const path = posix.isAbsolute(storage) ? storage : posix.join('/', storage)
        const base: MapResolver = { proxyId: proxy.container.id, name: r.name, challenge: r.challenge, dnsProvider: r.dnsProvider, staging: r.staging, storage: path, accountRegistered: null, certificates: 0, error: null }
        if (!proxy.container.running) {
          resolvers.push({ ...base, error: 'Proxy arrêté' })
          continue
        }
        if (!files.has(path)) {
          files.set(path, p.readContainerFiles(conn, epId, proxy.container.id, path, ACME_LIMITS)
            .then(f => f?.[0]?.content ?? new Error('Stockage absent (aucun certificat obtenu)'))
            .catch(err => new Error(`Lecture impossible : ${errMsg(err)}`)))
        }
        const content = await files.get(path)!
        if (content instanceof Error) {
          resolvers.push({ ...base, error: content.message })
          continue
        }
        const store = parseAcmeStore(content, r.name)
        certsByResolver.set(r.name, store.certificates)
        resolvers.push({ ...base, accountRegistered: store.accountRegistered, certificates: store.certificates.length })
      }
    }
    // Traefik géré : certificats importés en service, servis en priorité pour les domaines qu'ils couvrent.
    const imported = proxy.container.stack === MANAGED_PROXY_STACK ? (await listCertificates(row.ep.id)).filter(c => !c.pendingApply && c.state !== 'expired') : []
    // nginx déclaré : certificats déposés par la console (importés ou Let's Encrypt), même choix que le dépôt.
    const consoleCerts = proxy.nginx?.managed ? await listCertificates(row.ep.id) : null
    if (proxy.nginx?.managed?.acme) {
      const [cfg] = await db().select().from(schema.traefikConfigs).where(eq(schema.traefikConfigs.endpointId, row.ep.id))
      const dns = await db().select({ provider: schema.dnsAccounts.provider }).from(schema.dnsAccounts)
      resolvers.push({
        proxyId: proxy.container.id,
        name: 'Let\'s Encrypt (console)',
        challenge: dns.length ? 'dns' : 'http',
        dnsProvider: dns.length ? [...new Set(dns.map(d => DNS_PROVIDER_LABEL[d.provider]))].join(', ') : null,
        staging: cfg?.nginxAcmeDirectory === 'letsencrypt-staging',
        storage: proxy.nginx.managed.certsDir,
        accountRegistered: !!cfg?.nginxAcmeAccountSecretId,
        certificates: consoleCerts!.filter(c => c.source === 'acme').length,
        error: null,
      })
    }
    const seen = new Set<string>()
    for (const route of routes) {
      for (const host of route.hosts) {
        if (consoleCerts) {
          if (seen.has(host)) continue
          seen.add(host)
          const c = pickCertificate(consoleCerts.map(x => ({ ...x, notAfter: new Date(x.notAfter), notBefore: new Date(x.notBefore) })), host)
          if (c) certificates.push({ proxyId: proxy.container.id, host, resolver: c.source === 'acme' ? 'Let\'s Encrypt (console)' : null, state: c.state, issuer: `${c.issuer} (${c.source === 'acme' ? 'Let\'s Encrypt, console' : 'importé'})`, notAfter: c.notAfter.toISOString(), staging: false, error: null })
          else certificates.push({ proxyId: proxy.container.id, host, resolver: null, state: 'static', issuer: null, notAfter: null, staging: false, error: null })
          continue
        }
        const own = imported.find(c => certificateCovers(c.domains, host))
        if (own) {
          if (seen.has(`${host}|imported`)) continue
          seen.add(`${host}|imported`)
          certificates.push({ proxyId: proxy.container.id, host, resolver: null, state: own.state, issuer: `${own.issuer} (importé)`, notAfter: own.notAfter, staging: false, error: null })
          continue
        }
        const key = `${host}|${route.certResolver ?? ''}`
        if (seen.has(key)) continue
        seen.add(key)
        if (!route.certResolver) {
          certificates.push({ proxyId: proxy.container.id, host, resolver: null, state: 'static', issuer: null, notAfter: null, staging: false, error: null })
          continue
        }
        const d = domainState(host, certsByResolver.get(route.certResolver) ?? [], errors)
        certificates.push({ proxyId: proxy.container.id, host, resolver: route.certResolver, state: d.state, issuer: d.certificate?.issuer ?? null, notAfter: d.certificate?.notAfter ?? null, staging: d.certificate?.staging ?? false, error: d.error })
      }
    }
  }
  certificates.sort((a, b) => a.host.localeCompare(b.host))
  return { topology, containers, resolvers, certificates, acmeErrors }
}

export function endpointProxyMap(row: EndpointRow, opts: { refresh?: boolean, progress?: Progress } = {}): Promise<ProxyMapDto> {
  const hit = cache.get(row.ep.id)
  if (!opts.refresh && hit && Date.now() - hit.at < TTL_MS) return hit.value
  const value = build(row, !!opts.refresh, opts.progress ?? noProgress)
  cache.set(row.ep.id, { at: Date.now(), value })
  value.catch(() => cache.delete(row.ep.id))
  return value
}

export function invalidateProxyMap(endpointId: string): void {
  cache.delete(endpointId)
}
