/**
 * Mise en service : état réel de chaque prérequis de production, vérifié en
 * direct (fournisseurs OIDC joignables, derniers envois, Runners, chemins,
 * clés), avec le lien vers l'écran où agir. Aucune valeur secrète n'est renvoyée.
 */
import { type Progress, noProgress } from '../utils/progress'
import { and, count, desc, eq, inArray, isNotNull } from 'drizzle-orm'
import { db, schema } from '../db/client'
import { oidcConfig } from '../auth/oidc'
import { smtpConfigured } from '../adapters/notifications/email'
import { WORKER_HEARTBEAT_KEY } from '../queue/queues'
import { redis } from '../queue/redis'
import { env } from '../utils/env'
import { getUpdateEngine } from './update-engine'
import { getKeyring } from '../utils/crypto'
import { globalAdminUserIds } from './admin'

export type CheckStatus = 'ok' | 'warning' | 'error' | 'todo' | 'info'
export interface CheckItem { key: string, label: string, status: CheckStatus, detail: string, link?: string }
export interface CheckSection { key: string, title: string, items: CheckItem[] }
export interface ReadinessReport { checkedAt: string, summary: Record<CheckStatus, number>, sections: CheckSection[] }

const RUNNER_STALE_MS = 15 * 60_000

/** Adresse par laquelle l'administrateur consulte la page (pour expliquer un écart avec APP_URL). */
export interface AccessOrigin { origin: string, https: boolean }

export async function security(access?: AccessOrigin): Promise<CheckSection> {
  const e = env()
  const items: CheckItem[] = []
  // Le contrôle porte sur APP_URL (liens, OIDC, notifications), pas sur l'adresse du navigateur :
  // passer derrière un proxy HTTPS ne suffit pas, la variable doit suivre (redémarrage de app et worker).
  const viaHttps = access?.https && access.origin !== e.APP_URL
    ? `consultée via ${access.origin}, mais APP_URL=${e.APP_URL} : définir APP_URL=${access.origin} et COOKIE_SECURE=true, puis redémarrer app et worker`
    : null
  items.push(e.APP_URL.startsWith('https://')
    ? { key: 'https', label: 'URL publique en HTTPS', status: 'ok', detail: e.APP_URL }
    : { key: 'https', label: 'URL publique en HTTPS', status: e.NODE_ENV === 'production' ? 'error' : 'warning', detail: viaHttps ?? `APP_URL=${e.APP_URL} : HTTPS requis en production (reverse proxy, puis APP_URL en https:// et redémarrage)` })
  items.push({ key: 'cookie', label: 'Cookies de session « Secure »', status: e.COOKIE_SECURE ? 'ok' : (e.NODE_ENV === 'production' ? 'error' : 'warning'), detail: e.COOKIE_SECURE ? 'Actif' : 'COOKIE_SECURE=false : réservé au développement' })
  items.push({ key: 'mode', label: 'Mode production', status: e.NODE_ENV === 'production' ? 'ok' : 'warning', detail: `NODE_ENV=${e.NODE_ENV}` })
  const beat = await redis().get(WORKER_HEARTBEAT_KEY).catch(() => null)
  items.push({ key: 'worker', label: 'Worker actif', status: beat ? 'ok' : 'error', detail: beat ? `Dernier signal : ${new Date((JSON.parse(beat) as { at: string }).at).toLocaleString('fr-FR', { timeZone: 'Europe/Paris' })}` : 'Aucun worker : les déploiements et notifications restent en file' })
  const ring = getKeyring()
  const byKey = await db().select({ keyId: schema.secrets.keyId, n: count() }).from(schema.secrets).groupBy(schema.secrets.keyId)
  const old = byKey.filter(k => k.keyId !== ring.currentId).reduce((a, k) => a + k.n, 0)
  items.push(old
    ? { key: 'keys', label: 'Secrets chiffrés avec la clé courante', status: 'warning', detail: `${old} secret(s) encore chiffré(s) avec une ancienne clé : lancer la rotation (dist/rekey.mjs, voir docs/exploitation.md)` }
    : { key: 'keys', label: 'Secrets chiffrés avec la clé courante', status: 'ok', detail: `Clé ${ring.currentId}, ${byKey.reduce((a, k) => a + k.n, 0)} secret(s)` })
  return { key: 'security', title: 'Accès et sécurité', items }
}

async function accounts(): Promise<CheckSection> {
  const items: CheckItem[] = []
  const adminIds = await globalAdminUserIds()
  const admins = adminIds.length ? await db().select({ id: schema.users.id, kind: schema.users.kind }).from(schema.users).where(inArray(schema.users.id, adminIds)) : []
  const localAdmins = admins.filter(a => a.kind === 'local').length
  items.push({
    key: 'break-glass', label: 'Compte local de secours (administrateur)', link: '/admin/users',
    status: localAdmins >= 1 ? 'ok' : 'error',
    detail: localAdmins >= 1 ? `${localAdmins} administrateur(s) local(aux) : accès garanti si le SSO est indisponible` : 'Aucun administrateur local : prévoir un compte de secours',
  })
  items.push({ key: 'admins', label: 'Au moins deux administrateurs', status: admins.length >= 2 ? 'ok' : 'warning', detail: `${admins.length} administrateur(s) actif(s)`, link: '/admin/users' })

  const idps = await db().select().from(schema.identityProviders)
  if (!idps.length) items.push({ key: 'sso', label: 'Fournisseur SSO (Keycloak, Okta)', status: 'todo', detail: 'Aucun fournisseur configuré', link: '/admin/sso' })
  for (const idp of idps) {
    const base = { link: '/admin/sso' }
    if (!idp.enabled) {
      items.push({ ...base, key: `idp-${idp.key}`, label: `SSO ${idp.name}`, status: 'info', detail: 'Désactivé' })
      continue
    }
    let reachable: string | null = null
    try {
      await oidcConfig(idp)
    }
    catch (err) {
      reachable = (err as Error).message
    }
    const [{ n: mappings }] = await db().select({ n: count() }).from(schema.idpGroupMappings).where(eq(schema.idpGroupMappings.idpId, idp.id)) as [{ n: number }]
    const [last] = await db().select({ at: schema.users.lastLoginAt }).from(schema.users).where(and(eq(schema.users.idpId, idp.id), isNotNull(schema.users.lastLoginAt))).orderBy(desc(schema.users.lastLoginAt)).limit(1)
    const issues = [
      reachable ? `découverte OIDC en échec (${reachable})` : null,
      !mappings ? 'aucun groupe mappé' : null,
      !idp.requireMappedGroup ? 'accès sans groupe mappé autorisé' : null,
    ].filter(Boolean)
    items.push({
      ...base, key: `idp-${idp.key}`, label: `SSO ${idp.name} (${idp.kind})`,
      status: reachable ? 'error' : issues.length ? 'warning' : last?.at ? 'ok' : 'todo',
      detail: issues.length ? issues.join(' ; ') : last?.at ? `Émetteur joignable, ${mappings} groupe(s) mappé(s), dernière connexion ${last.at.toLocaleString('fr-FR', { timeZone: 'Europe/Paris' })}` : `Émetteur joignable, ${mappings} groupe(s) mappé(s) : se connecter une première fois pour valider`,
    })
  }
  return { key: 'accounts', title: 'Comptes et SSO', items }
}

async function notifications(): Promise<CheckSection> {
  const items: CheckItem[] = []
  const channels = await db().select().from(schema.notificationChannels)
  const lastOf = async (channelId: string) => (await db().select({ status: schema.notificationDeliveries.status, at: schema.notificationDeliveries.createdAt, error: schema.notificationDeliveries.error })
    .from(schema.notificationDeliveries).where(eq(schema.notificationDeliveries.channelId, channelId)).orderBy(desc(schema.notificationDeliveries.createdAt)).limit(1))[0]
  items.push({ key: 'smtp', label: 'Serveur SMTP', status: smtpConfigured() ? 'ok' : 'todo', detail: smtpConfigured() ? `${env().SMTP_HOST}:${env().SMTP_PORT}` : 'SMTP_HOST non défini : pas d\'email ni d\'invitation par email', link: '/admin/notifications' })
  for (const kind of ['email', 'teams_webhook'] as const) {
    const list = channels.filter(c => c.kind === kind && c.enabled)
    const label = kind === 'email' ? 'Canal email' : 'Canal Teams'
    if (!list.length) {
      items.push({ key: `ch-${kind}`, label, status: 'todo', detail: 'Aucun canal actif', link: '/admin/notifications' })
      continue
    }
    for (const c of list) {
      const last = await lastOf(c.id)
      items.push({
        key: `ch-${c.id}`, label: `${label} « ${c.name} »`, link: '/admin/notifications',
        status: !last ? 'todo' : last.status === 'sent' ? 'ok' : last.status === 'failed' ? 'error' : 'info',
        detail: !last ? 'Jamais utilisé : bouton « Tester »' : last.status === 'sent' ? `Dernier envoi réussi le ${last.at.toLocaleString('fr-FR', { timeZone: 'Europe/Paris' })}` : `Dernier envoi en échec : ${last.error ?? '—'}`,
      })
    }
  }
  const critical = ['deployment.failed', 'build.failed', 'server.unavailable']
  const missing = critical.filter(ev => !channels.some(c => c.enabled && c.events.includes(ev)))
  items.push({ key: 'coverage', label: 'Alertes critiques couvertes', status: missing.length ? 'warning' : 'ok', detail: missing.length ? `Sans canal : ${missing.join(', ')}` : 'Échecs de déploiement et de build, serveurs indisponibles', link: '/admin/notifications' })
  return { key: 'notifications', title: 'Notifications', items }
}

async function infrastructure(): Promise<CheckSection> {
  const items: CheckItem[] = []
  const servers = await db().select().from(schema.portainerServers)
  if (!servers.length) items.push({ key: 'servers', label: 'Hôtes (agent Portainer ou SSH)', status: 'todo', detail: 'Aucun serveur déclaré', link: '/servers/new' })
  for (const s of servers) {
    items.push({ key: `srv-${s.id}`, label: `${s.transport === 'ssh' ? 'Hôte SSH' : 'Agent'} ${s.name}`, link: `/servers/${s.id}`, status: s.status === 'online' ? 'ok' : s.status === 'degraded' ? 'warning' : 'error', detail: `${s.status}${s.detectedVersion ? ` · v${s.detectedVersion}` : ''}${s.lastError ? ` · ${s.lastError}` : ''}` })
  }
  const endpoints = await db().select({ ep: schema.serverEndpoints, server: schema.portainerServers.name, serverId: schema.portainerServers.id, transport: schema.portainerServers.transport, serverStatus: schema.portainerServers.status }).from(schema.serverEndpoints)
    .innerJoin(schema.portainerServers, eq(schema.portainerServers.id, schema.serverEndpoints.serverId))
    .where(and(eq(schema.serverEndpoints.enabled, true), eq(schema.serverEndpoints.missing, false)))
  if (servers.length && !endpoints.length) items.push({ key: 'endpoints', label: 'Endpoints activés', status: 'todo', detail: 'Aucun endpoint activé pour les déploiements', link: '/servers' })
  for (const { ep, server, serverId, transport, serverStatus } of endpoints) {
    const link = `/servers/${serverId}`
    const envs = await db().select({ id: schema.environments.id, name: schema.environments.name }).from(schema.endpointEnvironments)
      .innerJoin(schema.environments, eq(schema.environments.id, schema.endpointEnvironments.environmentId)).where(eq(schema.endpointEnvironments.endpointId, ep.id))
    const paths = await db().select({ environmentId: schema.pathConfigs.environmentId }).from(schema.pathConfigs).where(eq(schema.pathConfigs.endpointId, ep.id))
    const [runner] = await db().select().from(schema.targetRunners).where(eq(schema.targetRunners.endpointId, ep.id))
    const [traefik] = await db().select({ id: schema.traefikConfigs.id }).from(schema.traefikConfigs).where(eq(schema.traefikConfigs.endpointId, ep.id)).limit(1)
    const missingPaths = envs.filter(e => !paths.some(p => p.environmentId === e.id)).map(e => e.name)
    const label = `${server} / ${ep.name}`
    items.push({ key: `ep-env-${ep.id}`, label: `${label} : environnements et chemins`, link, status: !envs.length ? 'todo' : missingPaths.length ? 'warning' : 'ok', detail: !envs.length ? 'Aucun environnement associé' : missingPaths.length ? `Chemins de travail manquants : ${missingPaths.join(', ')}` : `${envs.map(e => e.name).join(', ')} : chemins configurés` })
    const fresh = runner?.lastCheckedAt && Date.now() - runner.lastCheckedAt.getTime() < RUNNER_STALE_MS
    if (transport === 'ssh') {
      // Sans Runner : fichiers par SFTP et build par l'API Docker, sous les racines des chemins configurés.
      items.push({
        key: `ep-runner-${ep.id}`, label: `${label} : fichiers et build (SSH)`, link,
        status: serverStatus !== 'online' ? 'error' : !paths.length ? 'todo' : 'ok',
        detail: serverStatus !== 'online' ? 'Hôte SSH injoignable : dépôt de fichiers et build impossibles' : !paths.length ? 'Aucun chemin configuré : aucune racine autorisée' : 'Par la connexion SSH (SFTP et API Docker), limités aux racines des chemins configurés',
      })
    }
    else items.push({
      key: `ep-runner-${ep.id}`, label: `${label} : Target Runner`, link,
      status: !runner ? 'todo' : runner.lastError ? 'error' : fresh ? 'ok' : 'warning',
      detail: !runner ? 'Aucun Runner : dépôt de fichiers et build impossibles' : runner.lastError ? `Dernier contrôle en échec : ${runner.lastError}` : runner.lastCheckedAt ? `${runner.url} · v${runner.version ?? '?'} · contrôlé ${runner.lastCheckedAt.toLocaleString('fr-FR', { timeZone: 'Europe/Paris' })}` : `${runner.url} · jamais contrôlé`,
    })
    items.push({ key: `ep-traefik-${ep.id}`, label: `${label} : Traefik`, link, status: traefik ? 'ok' : 'info', detail: traefik ? 'Configuré (domaines contrôlés)' : 'Non configuré : pas d\'exposition web par domaine (facultatif)' })
  }
  // Moteur de mise à jour des images (Watchtower) : image maintenue, figée, appliquée partout.
  const engine = await getUpdateEngine().catch(() => null)
  if (engine) {
    const newer = engine.latest && engine.latest.replace(/^v/, '') !== engine.tag.replace(/^v/, '')
    items.push({
      key: 'update-engine', label: 'Moteur de mise à jour des images', link: '/images',
      status: engine.catalog.status === 'archived' ? 'error' : engine.outdated.length || !engine.digest || engine.envRetired ? 'warning' : newer ? 'info' : 'ok',
      detail: [
        `${engine.repository}:${engine.tag} (${engine.catalog.status === 'archived' ? 'projet archivé' : 'maintenu'})`,
        engine.digest ? 'figé par empreinte' : 'non figé : choisir une version',
        engine.outdated.length ? `${engine.outdated.length} cible(s) à basculer` : null,
        engine.envRetired ? `WATCHTOWER_IMAGE archivée ignorée (${engine.envRetired})` : null,
        newer ? `version ${engine.latest} disponible` : null,
      ].filter(Boolean).join(' · '),
    })
  }
  return { key: 'infrastructure', title: 'Serveurs cibles', items }
}

async function github(): Promise<CheckSection> {
  const items: CheckItem[] = []
  const apis = env().GITHUB_ALLOWED_API_URLS.split(',').map(x => x.trim()).filter(Boolean)
  items.push({ key: 'apis', label: 'API GitHub autorisées', status: 'info', detail: apis.join(', ') })
  const sources = await db().select({ s: schema.projectSources, project: schema.projects.name, projectId: schema.projects.id }).from(schema.projectSources)
    .innerJoin(schema.projects, eq(schema.projects.id, schema.projectSources.projectId)).where(eq(schema.projectSources.kind, 'github'))
  if (!sources.length) items.push({ key: 'sources', label: 'Projets sur GitHub', status: 'info', detail: 'Aucun projet n\'utilise encore une source GitHub' })
  for (const { s, project, projectId } of sources) {
    const blocked = !apis.includes(s.apiUrl.replace(/\/+$/, ''))
    items.push({
      key: `src-${s.id}`, label: `${project} — ${s.repository}`, link: `/projects/${projectId}`,
      status: blocked ? 'error' : 'info',
      detail: blocked ? `API ${s.apiUrl} non autorisée (GITHUB_ALLOWED_API_URLS)` : `${s.tokenSecretId ? 'Avec token (dépôt privé ou limite levée)' : 'Sans token (dépôt public uniquement)'} · ${s.refType}:${s.ref} · onglet Source → « Tester l'accès »`,
    })
  }
  return { key: 'github', title: 'Sources GitHub', items }
}

async function operations(): Promise<CheckSection> {
  const items: CheckItem[] = []
  const [purge] = await db().select({ ts: schema.auditEvents.ts }).from(schema.auditEvents).where(eq(schema.auditEvents.action, 'retention.purge')).orderBy(desc(schema.auditEvents.ts)).limit(1)
  items.push({ key: 'retention', label: 'Purge de rétention', status: purge && Date.now() - purge.ts.getTime() < 2 * 864e5 ? 'ok' : 'info', detail: `${env().RETENTION_DAYS} jours · dernière purge : ${purge ? purge.ts.toLocaleString('fr-FR', { timeZone: 'Europe/Paris' }) : 'jamais'}`, link: '/admin/retention' })
  items.push({ key: 'backup', label: 'Sauvegardes planifiées et restauration testée', status: 'todo', detail: 'À vérifier hors plateforme : deploy/backup.sh planifié, clé maîtresse au coffre (docs/exploitation.md)' })
  items.push({ key: 'e2e', label: 'Recette navigateur sur cet environnement', status: 'todo', detail: 'npm run test:e2e avec E2E_BASE_URL pointant ici (docs/recette.md)' })
  return { key: 'operations', title: 'Exploitation', items }
}

export async function readinessReport(progress: Progress = noProgress, access?: AccessOrigin): Promise<ReadinessReport> {
  // Séquentiel : chaque domaine est annoncé (les fournisseurs SSO et les Runners peuvent être lents).
  const steps: [string, () => Promise<CheckSection>][] = [
    ['Installation : HTTPS, worker, clés', () => security(access)],
    ['Comptes et fournisseurs SSO (découverte OIDC)', accounts],
    ['Notifications : SMTP, canaux, derniers envois', notifications],
    ['Serveurs, endpoints, chemins et Runners', infrastructure],
    ['Sources GitHub', github],
    ['Exploitation : rétention, sauvegardes', operations],
  ]
  const sections: CheckSection[] = []
  for (const [i, [label, fn]] of steps.entries()) {
    await progress.step(label, i + 1, steps.length)
    sections.push(await fn())
  }
  const summary: Record<CheckStatus, number> = { ok: 0, warning: 0, error: 0, todo: 0, info: 0 }
  for (const s of sections) for (const i of s.items) summary[i.status]++
  return { checkedAt: new Date().toISOString(), summary, sections }
}
