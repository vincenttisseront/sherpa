/**
 * Traefik géré par la plateforme (stack platform-traefik sur l'endpoint) :
 * enregistrement de la configuration (identifiants DNS chiffrés), aperçu
 * (Compose généré, réseaux à créer, conflits de ports) et application via
 * l'agent. Après application, la configuration Traefik de l'endpoint (réseau,
 * résolveur, points d'entrée) est alignée automatiquement.
 */
import { and, eq, inArray, isNull } from 'drizzle-orm'
import { createError } from 'h3'
import { type AcmeStatusDto, MANAGED_PROXY_STACK, MANAGED_RESOLVER, type ManagedProxyConfig, type ManagedProxyDto, type ManagedProxyInput, type ManagedProxyPreview } from '../../shared/schemas/managed-proxy'
import { portainer } from '../adapters/portainer'
import { db, schema } from '../db/client'
import { covers, domainState, parseAcmeLogs, parseAcmeStore } from '../lib/proxy/acme'
import { managedTraefikCompose } from '../lib/proxy/managed'
import { certificateCovers } from '../lib/proxy/certificates'
import { certificatesForApply, expectedApplied, listCertificates } from './proxy-certificates'
import { ensureProxyRouteNetworks, routesForApply } from './proxy-routes'
import { decryptSecret, encryptSecret } from '../utils/crypto'
import { type Progress, noProgress } from '../utils/progress'
import { PROXY_DEFAULTS } from '../../shared/schemas/infra'
import { upsertTraefikConfig } from './infra-config'
import type { EndpointRow } from './live'
import { connectionFor, portainerErrorMessage, rediscover } from './servers'
import { byCode } from '../../shared/utils/compare'

type Row = typeof schema.managedProxies.$inferSelect

async function rowOf(endpointId: string): Promise<Row | undefined> {
  const [r] = await db().select().from(schema.managedProxies).where(eq(schema.managedProxies.endpointId, endpointId))
  return r
}

async function dnsEnv(r: Row | undefined): Promise<Record<string, string>> {
  if (!r?.dnsEnvSecretId) return {}
  const [s] = await db().select({ envelope: schema.secrets.envelope }).from(schema.secrets).where(eq(schema.secrets.id, r.dnsEnvSecretId))
  return s ? JSON.parse(decryptSecret(s.envelope)) as Record<string, string> : {}
}

export async function getManagedProxy(endpointId: string): Promise<ManagedProxyDto> {
  const r = await rowOf(endpointId)
  if (!r) return { config: null, dnsEnvNames: [], status: 'none', pending: false, appliedAt: null, lastError: null }
  return {
    config: r.config,
    dnsEnvNames: Object.keys(await dnsEnv(r)).sort(byCode),
    status: r.status as ManagedProxyDto['status'],
    // Configuration ou certificats importés différents de ceux en service.
    pending: JSON.stringify(r.config) !== JSON.stringify(r.appliedConfig) || JSON.stringify(await expectedApplied(endpointId)) !== JSON.stringify([...r.appliedCertificates].sort(byCode))
      || JSON.stringify((await routesForApply(endpointId)).applied) !== JSON.stringify([...r.appliedRoutes].sort(byCode)),
    appliedAt: r.appliedAt?.toISOString() ?? null,
    lastError: r.lastError,
  }
}

/** Enregistre sans appliquer ; une variable DNS sans valeur garde la valeur actuelle. */
export async function saveManagedProxy(endpointId: string, input: ManagedProxyInput, userId: string | null): Promise<ManagedProxyDto> {
  const current = await rowOf(endpointId)
  const prev = await dnsEnv(current)
  const next: Record<string, string> = {}
  for (const v of input.dnsEnv) {
    if (v.value !== null) next[v.name] = v.value
    else if (prev[v.name] !== undefined) next[v.name] = prev[v.name]!
    else throw createError({ statusCode: 422, statusMessage: `Valeur manquante pour ${v.name}`, data: { errors: { dnsEnv: `Valeur manquante pour ${v.name}` } } })
  }
  await db().transaction(async (tx) => {
    let secretId = current?.dnsEnvSecretId ?? null
    if (Object.keys(next).length) {
      const { envelope, keyId } = encryptSecret(JSON.stringify(next))
      if (secretId) await tx.update(schema.secrets).set({ envelope, keyId, rotatedAt: new Date() }).where(eq(schema.secrets.id, secretId))
      else secretId = (await tx.insert(schema.secrets).values({ purpose: 'proxy_dns', envelope, keyId }).returning({ id: schema.secrets.id }))[0]!.id
    }
    else if (secretId) {
      await tx.update(schema.managedProxies).set({ dnsEnvSecretId: null }).where(eq(schema.managedProxies.endpointId, endpointId))
      await tx.delete(schema.secrets).where(eq(schema.secrets.id, secretId))
      secretId = null
    }
    const values = { config: input.config, dnsEnvSecretId: secretId, updatedBy: userId, status: current?.status === 'applied' ? 'applied' : 'draft' }
    if (current) await tx.update(schema.managedProxies).set(values).where(eq(schema.managedProxies.id, current.id))
    else await tx.insert(schema.managedProxies).values({ ...values, endpointId })
  })
  return getManagedProxy(endpointId)
}

export async function previewManagedProxy(row: EndpointRow): Promise<ManagedProxyPreview> {
  const r = await rowOf(row.ep.id)
  if (!r) throw createError({ statusCode: 404, statusMessage: 'Traefik géré non configuré pour cet endpoint' })
  const c = r.config
  const env = await dnsEnv(r)
  const conn = await connectionFor(row.server)
  const p = portainer()
  const [networks, containers] = await Promise.all([
    p.listNetworks(conn, row.ep.portainerEndpointId),
    p.listContainers(conn, row.ep.portainerEndpointId),
  ])
  const conflicts: string[] = []
  const warnings: string[] = []
  for (const port of [c.httpPort, c.httpsPort]) {
    for (const ct of containers) {
      if (ct.labels['com.docker.compose.project'] === MANAGED_PROXY_STACK) continue
      const clash = (ct.ports ?? []).find(x => x.publicPort === port && (c.bindAddress === '0.0.0.0' || !x.ip || x.ip === '0.0.0.0' || x.ip === '::' || x.ip === c.bindAddress))
      if (clash) conflicts.push(`Port ${port} déjà publié par ${ct.names[0] ?? ct.id.slice(0, 12)} (${ct.image})`)
    }
  }
  if (c.acme.enabled && c.acme.challenge === 'http' && c.httpPort !== 80) warnings.push(`Challenge HTTP : l'autorité ACME joint le port 80 ; le port ${c.httpPort} doit lui être redirigé`)
  if (c.acme.enabled && c.acme.challenge === 'tls' && c.httpsPort !== 443) warnings.push(`Challenge TLS : l'autorité ACME joint le port 443 ; le port ${c.httpsPort} doit lui être redirigé`)
  if (c.acme.enabled && c.acme.challenge === 'dns' && !Object.keys(env).length) warnings.push('Challenge DNS sans identifiants : renseigner les variables du fournisseur')
  if (c.acme.enabled && c.acme.staging) warnings.push('Autorité ACME de test : certificats non reconnus par les navigateurs')
  if (c.bindAddress !== '0.0.0.0' && c.acme.enabled && c.acme.challenge !== 'dns') warnings.push(`Écoute sur ${c.bindAddress} uniquement : l'autorité ACME doit pouvoir joindre cette adresse`)
  const tls = await certificatesForApply(row.ep.id)
  const routes = await routesForApply(row.ep.id)
  if (!c.acme.enabled && !tls.certs.length) warnings.push('Ni ACME ni certificat importé : Traefik servira son certificat auto-signé par défaut')
  return {
    composeText: managedTraefikCompose(c, Object.keys(env).sort(byCode), tls.certs, routes.routes),
    networksToCreate: c.networks.filter(n => !networks.some(x => x.name === n)),
    conflicts,
    warnings,
  }
}

const applying = new Set<string>()

/** Déploie (ou met à jour) le Traefik géré, puis aligne la configuration Traefik de l'endpoint. */
export async function applyManagedProxy(row: EndpointRow, progress: Progress = noProgress): Promise<ManagedProxyDto> {
  if (applying.has(row.ep.id)) throw createError({ statusCode: 409, statusMessage: 'Application déjà en cours' })
  applying.add(row.ep.id)
  const r = await rowOf(row.ep.id)
  try {
    if (!r) throw createError({ statusCode: 404, statusMessage: 'Traefik géré non configuré pour cet endpoint' })
    const total = 5
    await progress.step('Vérification des ports et des réseaux', 1, total)
    const pv = await previewManagedProxy(row)
    if (pv.conflicts.length) throw createError({ statusCode: 409, statusMessage: pv.conflicts.join(' ; ') })
    const conn = await connectionFor(row.server)
    const p = portainer()
    const epId = row.ep.portainerEndpointId
    for (const n of pv.networksToCreate) {
      await progress.step(`Création du réseau ${n}`, 2, total)
      await p.createNetwork(conn, epId, n)
    }
    // Conteneurs externes routés : rattachés au réseau du proxy avant que Traefik ne les cherche.
    await ensureProxyRouteNetworks(row)
    await progress.step('Déploiement de Traefik (docker compose)', 3, total)
    // Identifiants DNS et certificats importés : transmis par l'environnement de docker compose, jamais écrits.
    const tls = await certificatesForApply(row.ep.id)
    const env = [...Object.entries(await dnsEnv(r)).map(([name, value]) => ({ name, value })), ...tls.env]
    const input = { endpointId: epId, name: MANAGED_PROXY_STACK, composeContent: pv.composeText, env, pullImage: false }
    const existing = await p.findStack(conn, MANAGED_PROXY_STACK, epId)
    if (existing) await p.updateStack(conn, existing.id, input)
    else await p.createStack(conn, input)

    await progress.step('Synchronisation des réseaux', 4, total)
    await rediscover(row.server)
    await db().update(schema.networks).set({ policy: 'allowed', role: 'traefik' })
      .where(and(eq(schema.networks.endpointId, row.ep.id), inArray(schema.networks.name, r.config.networks)))

    await progress.step('Configuration Traefik de l\'endpoint alignée', 5, total)
    await alignEndpointConfig(row.ep.id, r.config)
    await db().update(schema.managedProxies).set({ status: 'applied', appliedConfig: r.config, appliedCertificates: tls.applied, appliedRoutes: (await routesForApply(row.ep.id)).applied, appliedAt: new Date(), lastError: null }).where(eq(schema.managedProxies.id, r.id))
  }
  catch (err) {
    if (r) await db().update(schema.managedProxies).set({ status: 'failed', lastError: portainerErrorMessage(err) }).where(eq(schema.managedProxies.id, r.id))
    throw err
  }
  finally {
    applying.delete(row.ep.id)
  }
  return getManagedProxy(row.ep.id)
}

/** Réseau, résolveur et points d'entrée de la plateforme = ceux du Traefik géré ; domaines et middlewares conservés. */
async function alignEndpointConfig(endpointId: string, c: ManagedProxyConfig) {
  const [current] = await db().select().from(schema.traefikConfigs).where(and(eq(schema.traefikConfigs.endpointId, endpointId), isNull(schema.traefikConfigs.environmentId)))
  await db().transaction(async (tx) => {
    await upsertTraefikConfig(tx, endpointId, {
      ...PROXY_DEFAULTS,
      networkName: c.networks[0]!,
      certResolver: c.acme.enabled ? MANAGED_RESOLVER : null,
      entrypointHttp: 'web',
      entrypointHttps: 'websecure',
      allowedDomains: current?.allowedDomains ?? [],
      defaultMiddlewares: current?.defaultMiddlewares ?? [],
      routerNamePattern: current?.routerNamePattern ?? '{project}-{env}-{service}',
      exposure: c.bindAddress === '0.0.0.0' ? 'external' : 'internal',
      redirectToHttps: c.redirectToHttps,
    })
  })
}

/**
 * État ACME du Traefik géré : certificats du stockage ACME (domaines, émetteur,
 * expiration ; jamais les clés) et dernières erreurs des logs, rapprochés des
 * domaines exposés par les projets de l'endpoint.
 */
export async function acmeStatus(row: EndpointRow): Promise<AcmeStatusDto> {
  const r = await rowOf(row.ep.id)
  const applied = r?.appliedConfig
  const base: AcmeStatusDto = { checkedAt: new Date().toISOString(), enabled: false, running: false, account: 'unknown', generalError: null, domains: [], orphanCertificates: 0 }
  if (!applied?.acme.enabled) return base
  const conn = await connectionFor(row.server)
  const p = portainer()
  const epId = row.ep.portainerEndpointId
  const ct = (await p.listContainers(conn, epId)).find(c => c.labels['com.docker.compose.project'] === MANAGED_PROXY_STACK && c.labels['com.docker.compose.service'] === 'traefik')
  const targets = await db().select({ exposures: schema.projectTargets.exposures, slug: schema.projects.slug })
    .from(schema.projectTargets)
    .innerJoin(schema.projects, eq(schema.projects.id, schema.projectTargets.projectId))
    .where(eq(schema.projectTargets.endpointId, row.ep.id))
  const hosts = [...new Map(targets.flatMap(t => t.exposures.map(e => [e.host.toLowerCase(), t.slug] as const))).entries()]
  if (!ct) return { ...base, enabled: true, domains: hosts.map(([host, project]) => ({ host, project, state: 'pending', issuer: null, notAfter: null, staging: false, error: 'Traefik géré absent de l\'hôte' })) }

  const [files, logs] = await Promise.all([
    p.readContainerFiles(conn, epId, ct.id, '/letsencrypt/acme.json', { maxBytes: 4 * 1024 * 1024, maxFiles: 1 }).catch(() => null),
    p.containerLogs(conn, epId, ct.id, 500).catch(() => [] as string[]),
  ])
  // Seuls domaines, émetteurs et dates sont retenus : le contenu brut (clés comprises) n'est pas conservé.
  const store = files?.[0] ? parseAcmeStore(files[0].content, MANAGED_RESOLVER) : { accountRegistered: false, certificates: [] }
  const errors = parseAcmeLogs(logs)
  // Certificats importés en service : Traefik les sert en priorité, aucune demande ACME pour ces domaines.
  const imported = (await listCertificates(row.ep.id)).filter(c => !c.pendingApply && c.state !== 'expired')
  const domains = hosts.map(([host, project]) => {
    const own = imported.find(c => certificateCovers(c.domains, host))
    if (own) return { host, project, state: own.state, issuer: own.issuer, notAfter: own.notAfter, staging: false, error: null, source: 'imported' as const }
    const d = domainState(host, store.certificates, errors)
    return { host, project, state: d.state, issuer: d.certificate?.issuer ?? null, notAfter: d.certificate?.notAfter ?? null, staging: d.certificate?.staging ?? false, error: d.error, source: 'acme' as const }
  })
  const general = [...errors].reverse().find(e => !e.domains.length)
  return {
    checkedAt: new Date().toISOString(),
    enabled: true,
    running: ct.state === 'running',
    account: store.accountRegistered ? 'registered' : 'not_registered',
    generalError: general?.message ?? null,
    domains,
    orphanCertificates: store.certificates.filter(c => !hosts.some(([h]) => covers(c, h))).length,
  }
}
