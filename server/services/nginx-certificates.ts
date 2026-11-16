/**
 * Certificats des reverse proxies nginx (classique et nginx-proxy) : certificats importés de
 * l'endpoint, ou obtenus par la console auprès d'une autorité ACME (Let's Encrypt, nginx classique),
 * déposés dans le conteneur nginx sous des noms stables par domaine (<dossier>/<domaine>.crt / .key)
 * puis référencés par la configuration des sites. Renouvellement quotidien 30 jours avant expiration :
 * les fichiers sont réécrits sous le même nom et nginx rechargé, sans toucher aux sites.
 */
import type { Readable } from 'node:stream'
import acme from 'acme-client'
import { eq, inArray } from 'drizzle-orm'
import { pack } from 'tar-stream'
import { type PortainerConnection, portainer } from '../adapters/portainer'
import { db, schema } from '../db/client'
import { CertificateRejected, parseCertificateBundle } from '../lib/proxy/certificates'
import { NGINX_ACME_WEBROOT, type NginxTlsFiles, hostsNeedingAcme, nginxCertFiles, nginxServedHosts, pickCertificate } from '../lib/proxy/nginx-sites'
import { decryptSecret, encryptSecret } from '../utils/crypto'
import { accountFor, acmePlan } from '../lib/dns/acme-plan'
import { waitForTxt } from '../lib/dns/propagation'
import { env } from '../utils/env'
import { apiOf, dnsAccountRows, markDnsError } from './dns-accounts'
import { connectionFor } from './servers'
import { trimTrailingSlashes } from '../../shared/utils/trim'

type DnsAccountRow = typeof schema.dnsAccounts.$inferSelect

type ProxyConfig = typeof schema.traefikConfigs.$inferSelect
type CertRow = typeof schema.proxyCertificates.$inferSelect
type Log = (message: string, level?: 'info' | 'warn' | 'error') => Promise<unknown>

/** nginx-proxy lit ses certificats dans /etc/nginx/certs (<domaine>.crt, default.crt). */
export const NGINX_PROXY_CERTS_DIR = '/etc/nginx/certs'

/** Conteneur nginx : endpoint de la console (certificats) et identifiant Portainer (API Docker). */
export interface NginxHandle { conn: PortainerConnection, endpoint: string, portainerEndpointId: number, containerId: string, name: string }

export const certsDirOf = (cfg: Pick<ProxyConfig, 'provider' | 'nginxCertsDir'>) => cfg.provider === 'nginx-proxy' ? NGINX_PROXY_CERTS_DIR : cfg.nginxCertsDir

export function acmeDirectoryUrl(dir: string): string {
  if (dir === 'letsencrypt') return acme.directory.letsencrypt.production
  if (dir === 'letsencrypt-staging') return acme.directory.letsencrypt.staging
  return dir
}

/** Conteneur nginx en marche, ou null. */
export async function nginxHandle(conn: PortainerConnection, ep: { id: string, portainerEndpointId: number }, name: string): Promise<NginxHandle | null> {
  const c = (await portainer().listContainers(conn, ep.portainerEndpointId)).find(x => x.names.includes(name))
  return c && c.state === 'running' ? { conn, endpoint: ep.id, portainerEndpointId: ep.portainerEndpointId, containerId: c.id, name } : null
}

export async function endpointCertificates(endpointId: string): Promise<CertRow[]> {
  return db().select().from(schema.proxyCertificates).where(eq(schema.proxyCertificates.endpointId, endpointId))
}

async function keyOf(row: CertRow): Promise<string> {
  const [s] = await db().select({ envelope: schema.secrets.envelope }).from(schema.secrets).where(eq(schema.secrets.id, row.keySecretId))
  if (!s) throw new Error(`Clé du certificat ${row.domains[0]} introuvable`)
  return decryptSecret(s.envelope)
}

/** Fichiers écrits dans le conteneur (chemins absolus ; dossiers parents créés par Docker). */
async function putFiles(h: NginxHandle, files: { path: string, content: string, mode: number }[]): Promise<void> {
  if (!files.length) return
  const tar = pack()
  for (const f of files) tar.entry({ name: f.path.replace(/^\/+/, ''), mode: f.mode }, f.content)
  tar.finalize()
  await portainer().putArchive(h.conn, h.portainerEndpointId, h.containerId, '/', tar as unknown as Readable, 60_000)
}

/**
 * Certificat retenu pour chaque domaine (exact, générique, puis par défaut) ; ses fichiers sont
 * déposés dans le conteneur. Renvoie les chemins par domaine, pour la configuration des sites.
 */
export async function pushNginxCertificates(h: NginxHandle, dir: string, hosts: readonly string[], opts: { withDefault?: boolean } = {}): Promise<Record<string, NginxTlsFiles>> {
  const rows = await endpointCertificates(h.endpoint)
  const tls: Record<string, NginxTlsFiles> = {}
  const files: { path: string, content: string, mode: number }[] = []
  const keys = new Map<string, string>()
  const key = async (r: CertRow) => keys.get(r.id) ?? keys.set(r.id, await keyOf(r)).get(r.id)!
  for (const host of new Set(hosts.map(x => x.toLowerCase()))) {
    const cert = pickCertificate(rows, host)
    if (!cert) continue
    const f = nginxCertFiles(dir, host)
    files.push({ path: f.certificate, content: `${cert.certPem.trim()}\n`, mode: 0o644 }, { path: f.key, content: `${(await key(cert)).trim()}\n`, mode: 0o600 })
    tls[host] = f
  }
  const def = opts.withDefault ? rows.find(r => r.isDefault && r.notAfter.getTime() > Date.now()) : undefined
  if (def) files.push({ path: `${dir}/default.crt`, content: `${def.certPem.trim()}\n`, mode: 0o644 }, { path: `${dir}/default.key`, content: `${(await key(def)).trim()}\n`, mode: 0o600 })
  await putFiles(h, files)
  return tls
}

async function acmeClient(cfg: ProxyConfig): Promise<acme.Client> {
  let accountKey: string
  if (cfg.nginxAcmeAccountSecretId) {
    const [s] = await db().select({ envelope: schema.secrets.envelope }).from(schema.secrets).where(eq(schema.secrets.id, cfg.nginxAcmeAccountSecretId))
    if (!s) throw new Error('Clé du compte ACME introuvable')
    accountKey = decryptSecret(s.envelope)
  }
  else {
    accountKey = (await acme.crypto.createPrivateKey()).toString()
    const { envelope, keyId } = encryptSecret(accountKey)
    const [secret] = await db().insert(schema.secrets).values({ purpose: 'nginx_acme_account', envelope, keyId }).returning({ id: schema.secrets.id })
    await db().update(schema.traefikConfigs).set({ nginxAcmeAccountSecretId: secret!.id }).where(eq(schema.traefikConfigs.id, cfg.id))
    cfg.nginxAcmeAccountSecretId = secret!.id
  }
  return new acme.Client({ directoryUrl: acmeDirectoryUrl(cfg.nginxAcmeDirectory), accountKey })
}

/**
 * Certificat obtenu auprès de l'autorité ACME pour ces noms : défi HTTP-01 servi par nginx depuis
 * NGINX_ACME_WEBROOT (déjà configuré pour le domaine), ou DNS-01 par l'API du compte DNS
 * (enregistrements TXT retirés ensuite). Enregistré (clé chiffrée) ; les certificats ACME
 * précédents de ces noms sont retirés.
 */
export async function issueAcmeCertificate(h: NginxHandle, cfg: ProxyConfig, names: string[], dns: DnsAccountRow | null): Promise<CertRow> {
  if (!cfg.nginxAcmeEmail) throw new Error('Let\'s Encrypt non configuré (adresse e-mail du compte)')
  const client = await acmeClient(cfg)
  const api = dns ? await apiOf(dns) : null
  const [key, csr] = await acme.crypto.createCsr({ commonName: names[0], altNames: names })
  const removers = new Map<string, () => Promise<void>>()
  const certPem = await client.auto({
    csr,
    email: cfg.nginxAcmeEmail,
    termsOfServiceAgreed: true,
    challengePriority: api ? ['dns-01'] : ['http-01'],
    // La console ne voit pas forcément le domaine comme Internet : l'autorité vérifie elle-même.
    skipChallengeVerification: true,
    challengeCreateFn: async (authz, challenge, keyAuthorization) => {
      if (challenge.type === 'dns-01' && api) {
        const fqdn = `_acme-challenge.${authz.identifier.value}`
        removers.set(`${fqdn} ${keyAuthorization}`, await api.addTxt(fqdn, keyAuthorization))
        await waitForTxt(fqdn, keyAuthorization, env().ACME_DNS_PROPAGATION_SEC)
        return
      }
      await putFiles(h, [{ path: `${NGINX_ACME_WEBROOT}/.well-known/acme-challenge/${challenge.token}`, content: keyAuthorization, mode: 0o644 }])
    },
    challengeRemoveFn: async (authz, _challenge, keyAuthorization) => {
      const k = `_acme-challenge.${authz.identifier.value} ${keyAuthorization}`
      await removers.get(k)?.().catch(() => {})
      removers.delete(k)
    },
  }).finally(async () => {
    for (const remove of removers.values()) await remove().catch(() => {})
  })
  const keyPem = key.toString()
  let parsed
  try {
    parsed = parseCertificateBundle(certPem, keyPem)
  }
  catch (err) {
    throw new Error(`Certificat reçu de l'autorité inutilisable : ${err instanceof CertificateRejected ? err.message : (err as Error).message}`, { cause: err })
  }
  const endpointId = h.endpoint
  const wanted = new Set(names)
  const previous = (await endpointCertificates(endpointId)).filter(r => r.source === 'acme' && r.domains.some(d => wanted.has(d.toLowerCase())))
  const { envelope, keyId } = encryptSecret(keyPem)
  return db().transaction(async (tx) => {
    const [secret] = await tx.insert(schema.secrets).values({ purpose: 'proxy_certificate_key', envelope, keyId }).returning({ id: schema.secrets.id })
    const [row] = await tx.insert(schema.proxyCertificates).values({
      endpointId,
      domains: parsed.domains,
      subject: parsed.subject,
      issuer: parsed.issuer,
      notBefore: new Date(parsed.notBefore),
      notAfter: new Date(parsed.notAfter),
      fingerprint: parsed.fingerprint,
      selfSigned: parsed.selfSigned,
      keyType: parsed.keyType,
      certPem: parsed.chainPem,
      keySecretId: secret!.id,
      isDefault: false,
      source: 'acme',
    }).returning()
    if (previous.length) {
      await tx.delete(schema.proxyCertificates).where(inArray(schema.proxyCertificates.id, previous.map(p => p.id)))
      await tx.delete(schema.secrets).where(inArray(schema.secrets.id, previous.map(p => p.keySecretId)))
    }
    return row!
  })
}

/**
 * Obtient les certificats manquants ou à renouveler ; renvoie les domaines désormais couverts.
 * Un certificat générique couvre ses voisins : la liste est recalculée après chaque obtention.
 */
export async function issueMissingAcme(h: NginxHandle, cfg: ProxyConfig, hosts: readonly string[], log: Log): Promise<string[]> {
  if (!cfg.nginxAcmeEmail || (cfg.provider !== 'nginx' && cfg.provider !== 'nginx-proxy')) return []
  // nginx-proxy : pas de défi HTTP-01 servi par la console, DNS-01 seulement (et pas avec acme-companion).
  const http = cfg.provider === 'nginx'
  if (!http && cfg.letsencrypt) return []
  const accounts = await dnsAccountRows()
  const done: string[] = []
  const tried = new Set<string>()
  for (;;) {
    const host = hostsNeedingAcme(await endpointCertificates(h.endpoint), hosts).find(x => !tried.has(x))
    if (!host) break
    tried.add(host)
    const account = accountFor(accounts, host)
    const plan = acmePlan(host, account, http)
    if ('skip' in plan) {
      if (http || host.startsWith('*.')) await log(`Let's Encrypt : ${plan.skip}`, 'warn')
      continue
    }
    const label = plan.names.join(', ')
    try {
      const row = await issueAcmeCertificate(h, cfg, plan.names, plan.method === 'dns-01' ? account : null)
      for (const n of plan.names) tried.add(n)
      done.push(...hosts.filter(x => row.domains.some(d => d.toLowerCase() === x.toLowerCase() || (d.startsWith('*.') && x.toLowerCase().endsWith(d.slice(1).toLowerCase()) && !x.slice(0, -(d.length - 1)).includes('.')))))
      await log(`Let's Encrypt : certificat obtenu pour ${label} (${plan.method}${account && plan.method === 'dns-01' ? `, compte DNS ${account.name}` : ''} ; ${row.issuer}, valable jusqu'au ${row.notAfter.toISOString().slice(0, 10)})`)
      if (account && plan.method === 'dns-01') await markDnsError(account.id, null)
    }
    catch (err) {
      await log(`Let's Encrypt : certificat non obtenu pour ${label} : ${(err as Error).message}`, 'warn')
      if (account && plan.method === 'dns-01') await markDnsError(account.id, (err as Error).message.slice(0, 500))
    }
  }
  return [...new Set(done)]
}

/** Configuration nginx d'un endpoint applicable à un environnement (propre à l'environnement d'abord). */
export function proxyConfigFor<T extends { environmentId: string | null }>(rows: readonly T[], environmentId: string): T | undefined {
  return rows.find(r => r.environmentId === environmentId) ?? rows.find(r => r.environmentId === null)
}

export interface CertSyncResult { endpointId: string, container: string | null, pushed: number, issued: string[], errors: string[] }

/**
 * Certificats d'un endpoint nginx mis à jour dans le conteneur : renouvellement ACME, puis dépôt des
 * fichiers des domaines exposés (noms stables) et rechargement de nginx. Un domaine encore en HTTP
 * seul passe en HTTPS au prochain déploiement de sa cible (configuration de site réécrite).
 */
export async function syncNginxCertificates(endpointId: string, log: Log = async () => {}): Promise<CertSyncResult[]> {
  const configs = (await db().select().from(schema.traefikConfigs).where(eq(schema.traefikConfigs.endpointId, endpointId)))
    .filter(c => (c.provider === 'nginx' || c.provider === 'nginx-proxy') && c.nginxContainer)
  if (!configs.length) return []
  const [row] = await db().select({ ep: schema.serverEndpoints, server: schema.portainerServers }).from(schema.serverEndpoints)
    .innerJoin(schema.portainerServers, eq(schema.portainerServers.id, schema.serverEndpoints.serverId))
    .where(eq(schema.serverEndpoints.id, endpointId))
  if (!row) return []
  const targets = (await db().select({ environmentId: schema.projectTargets.environmentId, exposures: schema.projectTargets.exposures, current: schema.projectTargets.currentReleaseId })
    .from(schema.projectTargets).where(eq(schema.projectTargets.endpointId, endpointId))).filter(t => t.current)
  const conn = await connectionFor(row.server)
  const out: CertSyncResult[] = []
  for (const cfg of configs) {
    const res: CertSyncResult = { endpointId, container: cfg.nginxContainer, pushed: 0, issued: [], errors: [] }
    out.push(res)
    try {
      const h = await nginxHandle(conn, row.ep, cfg.nginxContainer!)
      if (!h) {
        res.errors.push(`conteneur ${cfg.nginxContainer} arrêté ou introuvable`)
        continue
      }
      // nginx classique : domaines des sites réellement écrits (une cible pas encore redéployée derrière
      // nginx n'y figure pas) ; nginx-proxy : domaines des cibles déployées.
      const hosts = cfg.provider === 'nginx'
        ? nginxServedHosts(await portainer().readContainerFiles(conn, row.ep.portainerEndpointId, h.containerId, trimTrailingSlashes(cfg.nginxConfDir), { maxBytes: 4 * 1024 * 1024, maxFiles: 500 }) ?? [])
        : targets.filter(t => proxyConfigFor(configs, t.environmentId) === cfg).flatMap(t => t.exposures.map(e => e.host))
      res.issued = await issueMissingAcme(h, cfg, hosts, async (m, level) => {
        if (level === 'warn' || level === 'error') res.errors.push(m)
        return log(m, level)
      })
      const tls = await pushNginxCertificates(h, certsDirOf(cfg), hosts, { withDefault: cfg.provider === 'nginx-proxy' })
      res.pushed = Object.keys(tls).length
      // nginx-proxy : nginx relit ses certificats à la prochaine régénération (événement de conteneur).
      if (cfg.provider === 'nginx' && res.pushed) await portainer().signalContainer(conn, row.ep.portainerEndpointId, h.containerId, 'HUP')
    }
    catch (err) {
      res.errors.push((err as Error).message)
    }
  }
  return out
}

/** Maintenance quotidienne : tous les endpoints servis par nginx avec un conteneur déclaré. */
export async function renewAllNginxCertificates(): Promise<{ endpoints: number, issued: number, errors: number }> {
  const eps = await db().selectDistinct({ id: schema.traefikConfigs.endpointId }).from(schema.traefikConfigs)
    .where(inArray(schema.traefikConfigs.provider, ['nginx', 'nginx-proxy']))
  let issued = 0
  let errors = 0
  for (const { id } of eps) {
    const r = await syncNginxCertificates(id, async (m, level) => {
      if (level === 'warn' || level === 'error') console.warn(`[nginx-certificates] ${m}`)
    }).catch((err) => {
      console.warn(`[nginx-certificates] ${id} : ${(err as Error).message}`)
      return [] as CertSyncResult[]
    })
    issued += r.reduce((n, x) => n + x.issued.length, 0)
    errors += r.reduce((n, x) => n + x.errors.length, 0)
  }
  return { endpoints: eps.length, issued, errors }
}
