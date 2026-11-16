/**
 * Plan d'adressage d'un serveur : tous les réseaux Docker de l'hôte (projets de la console,
 * stacks Compose externes, réseaux de la plateforme, réseaux autonomes), leurs sous-réseaux et
 * leurs problèmes (taille démesurée, recouvrements, plages à éviter), et leur déplacement :
 *
 * - réseau d'un projet de la console : sous-réseau fixé puis redéploiement (Compose final cohérent) ;
 * - autre réseau : recréé EN DIRECT à l'identique dans le nouveau sous-réseau (mêmes options et
 *   labels, Compose compris), conteneurs déconnectés puis reconnectés avec leurs alias, sans
 *   redémarrage ; en cas d'erreur, réseau d'origine recréé et conteneurs reconnectés.
 */
import { eq } from 'drizzle-orm'
import { createError } from 'h3'
import type { AddressPlanDto, NetworkMoveInput, NetworkMovePlan, NetworkMoveResult, PlannedNetwork } from '../../shared/schemas/address-plan'
import { portainer } from '../adapters/portainer'
import type { NetworkDetail } from '../adapters/portainer/types'
import { db, schema } from '../db/client'
import { stackNameFor } from '../lib/compose/analyze'
import { type Cidr, capacity, firstFree, overlaps, parseCidr, within } from '../lib/subnets'
import { createLifecycleAction } from './deploy-requests'
import { pinSubnet } from './network-pool'
import { getTargetOr404 } from './projects'
import { connectionFor } from './servers'
import { byCode } from '../../shared/utils/compare'

const SYSTEM_NETWORKS = new Set(['bridge', 'host', 'none', 'docker_gwbridge', 'ingress'])
const TRAEFIK_IMAGE = /(^|\/)traefik(:|@|$)/i
/** Au-delà de 254 adresses pour un réseau d'application : taille démesurée (Docker donne des /16). */
const OVERSIZED_PREFIX = 23

async function endpointCtx(endpointId: string) {
  const [r] = await db().select({ ep: schema.serverEndpoints, server: schema.portainerServers })
    .from(schema.serverEndpoints)
    .innerJoin(schema.portainerServers, eq(schema.portainerServers.id, schema.serverEndpoints.serverId))
    .where(eq(schema.serverEndpoints.id, endpointId))
  if (!r) throw createError({ statusCode: 404, statusMessage: 'Endpoint introuvable' })
  return { ...r, conn: await connectionFor(r.server), epId: r.ep.portainerEndpointId }
}

/** Cibles de l'endpoint par nom de stack. */
async function targetsByStack(endpointId: string) {
  const rows = await db().select({ t: schema.projectTargets, project: schema.projects, env: schema.environments })
    .from(schema.projectTargets)
    .innerJoin(schema.projects, eq(schema.projects.id, schema.projectTargets.projectId))
    .innerJoin(schema.environments, eq(schema.environments.id, schema.projectTargets.environmentId))
    .where(eq(schema.projectTargets.endpointId, endpointId))
  return new Map(rows.map(r => [r.t.stackName ?? stackNameFor(r.project.slug, r.env.key), r]))
}

const hosts = (c: Cidr) => Math.max(0, 2 ** (32 - c.prefix) - 2)

export async function addressPlan(endpointId: string): Promise<AddressPlanDto> {
  const ctx = await endpointCtx(endpointId)
  const p = portainer()
  const pool = ctx.ep.networkPool ?? null
  const base = pool ? parseCidr(pool.base) : null
  const avoid = (pool?.avoid ?? []).map(parseCidr).filter((c): c is Cidr => !!c)
  const targets = await targetsByStack(endpointId)
  const list = await p.listNetworksDetailed(ctx.conn, ctx.epId)
  const details = await Promise.all(list.map(n => p.inspectNetwork(ctx.conn, ctx.epId, n.id).catch(() => null)))
  const all = list.map((n, i) => ({ n, d: details[i], cidrs: (n.subnets ?? []).map(parseCidr).filter((c): c is Cidr => !!c) }))
  // Conteneurs qu'un déplacement en direct casserait : Traefik (il ne relit pas les nouvelles adresses
  // de ses backends) et la console elle-même (elle perdrait la connexion pendant l'opération).
  const containers = await p.listContainers(ctx.conn, ctx.epId)
  const traefikIds = new Set(containers.filter(c => TRAEFIK_IMAGE.test(c.image)).map(c => c.id))
  const self = process.env.HOSTNAME ? containers.find(c => c.id.startsWith(process.env.HOSTNAME!)) : undefined
  const consoleStack = self?.labels['com.docker.compose.project']
  const consoleIds = new Set(consoleStack ? containers.filter(c => c.labels['com.docker.compose.project'] === consoleStack).map(c => c.id) : self ? [self.id] : [])

  const networks: PlannedNetwork[] = all.map(({ n, d, cidrs }): PlannedNetwork => {
    const stack = n.labels['com.docker.compose.project']
    const target = stack ? targets.get(stack) : undefined
    const system = SYSTEM_NETWORKS.has(n.name) || n.driver !== 'bridge' || n.scope !== 'local'
    const owner: PlannedNetwork['owner'] = system
      ? { kind: 'system' }
      : target
        ? { kind: 'project', project: target.project.name, environment: target.env.name, targetId: target.t.id, network: n.labels['com.docker.compose.network'] ?? 'default', stack }
        : stack ? { kind: 'compose', stack, network: n.labels['com.docker.compose.network'] }
          : n.labels['platform.managed'] === 'true' ? { kind: 'platform' } : { kind: 'standalone' }
    const issues: PlannedNetwork['issues'] = []
    for (const c of cidrs) {
      for (const a of avoid) if (overlaps(c, a)) issues.push({ kind: 'avoid', message: `${c.text} recouvre la plage à éviter ${a.text}` })
      for (const o of all) {
        if (o.n.id === n.id) continue
        for (const oc of o.cidrs) if (overlaps(c, oc)) issues.push({ kind: 'overlap', message: `${c.text} recouvre ${o.n.name} (${oc.text})` })
      }
      if (!system && c.prefix <= OVERSIZED_PREFIX) issues.push({ kind: 'oversized', message: `/${c.prefix} : ${hosts(c).toLocaleString('fr-FR')} adresses pour ${d?.containers.length ?? 0} conteneur(s)` })
    }
    let reason: string | null = null
    const attached = (d?.containers ?? []).map(c => c.id)
    if (system) reason = 'Réseau système de Docker'
    else if (!d) reason = 'Réseau illisible'
    else if (attached.some(id => consoleIds.has(id))) reason = `Réseau de la console elle-même (${consoleStack ?? 'conteneur de la console'}) : le déplacer couperait la console pendant l'opération ; régler ses sous-réseaux par Ansible (platform_network_subnets)`
    else if (attached.some(id => traefikIds.has(id))) reason = 'Réseau relié à Traefik : après un déplacement, Traefik garderait les anciennes adresses de ses backends (sites injoignables) ; non déplaçable'
    else if (owner.kind === 'project' && !target?.t.portainerStackId) reason = 'Projet jamais déployé : sous-réseau attribué à son premier déploiement'
    return {
      id: n.id,
      name: n.name,
      driver: n.driver,
      subnets: cidrs.map(c => c.text),
      addresses: cidrs.length ? Math.max(...cidrs.map(hosts)) : null,
      containers: (d?.containers ?? []).map(c => c.name).sort(byCode),
      owner,
      inPool: !!base && cidrs.length > 0 && cidrs.every(c => within(c, base)),
      issues,
      movable: !reason,
      moveMode: reason ? null : owner.kind === 'project' ? 'redeploy' : 'live',
      notMovableReason: reason,
    }
  }).sort((a, b) => Number(a.owner.kind === 'system') - Number(b.owner.kind === 'system') || b.issues.length - a.issues.length || a.name.localeCompare(b.name))

  const usedInPool = base ? all.filter(x => x.cidrs.some(c => within(c, base))).length : 0
  return { pool, networks, poolUsage: base && pool ? { used: usedInPool, capacity: capacity(base, pool.prefix) } : null }
}

/** Plan du déplacement : sous-réseau cible (choisi ou prochain libre de la plage), contrôles, étapes. */
export async function planMove(endpointId: string, input: NetworkMoveInput) {
  const ctx = await endpointCtx(endpointId)
  const p = portainer()
  const plan = await addressPlan(endpointId)
  const net = plan.networks.find(n => n.name === input.network || n.id === input.network)
  if (!net) throw createError({ statusCode: 404, statusMessage: `Réseau ${input.network} introuvable sur l'hôte` })
  const detail = await p.inspectNetwork(ctx.conn, ctx.epId, net.id)
  const out: NetworkMovePlan = { network: net.name, from: net.subnets, to: null, mode: net.moveMode, containers: [], steps: [], blockers: [], warnings: [] }
  if (!net.movable || !detail) {
    out.blockers.push(net.notMovableReason ?? 'Réseau illisible')
    return { ctx, net, detail, plan: out }
  }

  // Conteneurs reliés : alias à rétablir, adresses fixes (bloquantes).
  for (const c of detail.containers) {
    const cfg = await p.inspectConfig(ctx.conn, ctx.epId, c.id)
    const n = cfg?.networks.find(x => x.name === net.name)
    if (n?.staticIp) out.blockers.push(`${c.name} a une adresse fixe (${n.staticIp}) dans ce réseau : la retirer de sa configuration avant de déplacer le réseau`)
    // Alias à rétablir, dont toujours le nom du service Compose (sans lui, les autres services ne le joignent plus).
    const service = cfg?.labels['com.docker.compose.service']
    const aliases = [...new Set([...(n?.aliases ?? []), ...(service ? [service] : [])])].filter(a => a !== c.id && !c.id.startsWith(a))
    out.containers.push({ name: c.name, aliases, running: cfg?.state === 'running' })
  }

  // Sous-réseau cible.
  const pool = ctx.ep.networkPool ?? null
  const base = pool ? parseCidr(pool.base) : null
  const others = plan.networks.filter(n => n.id !== net.id).flatMap(n => n.subnets)
  const pinned = await db().select({ subnet: schema.networkAllocations.subnet, targetId: schema.networkAllocations.targetId, network: schema.networkAllocations.network })
    .from(schema.networkAllocations).where(eq(schema.networkAllocations.endpointId, endpointId))
  const reserved = pinned.filter(a => !(net.owner.targetId && a.targetId === net.owner.targetId && a.network === net.owner.network)).map(a => a.subnet)
  const taken = [...others, ...reserved, ...(pool?.avoid ?? [])].map(parseCidr).filter((c): c is Cidr => !!c)
  let to: Cidr | null = null
  if (input.subnet) {
    to = parseCidr(input.subnet)
    if (!to) out.blockers.push(`Sous-réseau invalide : ${input.subnet}`)
    else {
      if (to.prefix < 16 || to.prefix > 29) out.blockers.push('Taille hors limites (/16 à /29)')
      const clash = taken.find(t => overlaps(to!, t))
      if (clash) out.blockers.push(`${to.text} recouvre ${clash.text} (déjà utilisé ou à éviter)`)
    }
  }
  else if (!pool || !base) out.blockers.push('Aucune plage définie pour cet endpoint : indiquer le sous-réseau cible, ou définir la plage')
  else {
    to = firstFree(base, pool.prefix, taken)
    if (!to) out.blockers.push(`Plage ${pool.base} épuisée`)
  }
  if (to && hosts(to) < detail.containers.length + 2) out.blockers.push(`${to.text} trop petit pour ${detail.containers.length} conteneur(s)`)
  if (to && net.subnets.includes(to.text)) out.blockers.push(`Le réseau est déjà en ${to.text}`)
  out.to = to?.text ?? null

  if (net.moveMode === 'redeploy') {
    out.steps = [
      `Sous-réseau ${out.to ?? '…'} fixé pour le réseau « ${net.owner.network} » du projet ${net.owner.project} (${net.owner.environment})`,
      'Redéploiement de la release active : Compose recrée le réseau dans le nouveau sous-réseau ; les conteneurs reliés redémarrent (volumes conservés)',
      'Healthchecks, puis retour automatique en cas d\'échec',
    ]
  }
  else {
    out.steps = [
      `Déconnexion des ${detail.containers.length} conteneur(s) (ils restent démarrés ; coupure réseau de quelques secondes)`,
      `Recréation du réseau ${net.name} à l'identique (driver, options, labels) en ${out.to ?? '…'}`,
      'Reconnexion des conteneurs avec leurs alias (noms DNS)',
      'En cas d\'erreur : réseau d\'origine recréé et conteneurs reconnectés',
    ]
    if (net.owner.kind === 'compose') {
      out.warnings.push(`Réseau de la stack Compose « ${net.owner.stack} » (hors console) : Compose le conserve, mais pour qu'il garde ce sous-réseau s'il est recréé (docker compose down), l'écrire dans son Compose : networks: ${net.owner.network ?? 'default'}: ipam: config: [{ subnet: ${out.to ?? '…'} }]`)
    }
    if (detail.internal) out.warnings.push('Réseau interne (sans accès extérieur) : propriété conservée')
  }
  return { ctx, net, detail, plan: out }
}

export async function moveNetwork(endpointId: string, input: NetworkMoveInput, user: { id: string | null, email: string }): Promise<NetworkMoveResult> {
  const { ctx, net, detail, plan } = await planMove(endpointId, input)
  if (input.dryRun || plan.blockers.length) {
    if (!input.dryRun) throw createError({ statusCode: 422, statusMessage: plan.blockers.join(' ; '), data: { plan } })
    return { plan }
  }

  if (plan.mode === 'redeploy') {
    const t = await getTargetOr404(net.owner.targetId!)
    await pinSubnet(endpointId, t.target.id, net.owner.network!, plan.to!)
    const deploymentId = await createLifecycleAction(t, 'redeploy', user.id, `net-move:${t.target.id}:${net.owner.network}-${plan.to!.replace('/', '_')}-${Date.now()}`)
    return { plan, deploymentId }
  }
  return { plan, log: await liveMove(ctx, detail!, plan) }
}

/** Déplacement en direct : déconnexion, recréation à l'identique dans le nouveau sous-réseau, reconnexion. */
async function liveMove(ctx: Awaited<ReturnType<typeof endpointCtx>>, d: NetworkDetail, plan: NetworkMovePlan): Promise<string[]> {
  const p = portainer()
  const log: string[] = []
  const spec = { name: d.name, driver: d.driver, internal: d.internal, attachable: d.attachable, enableIPv6: d.enableIPv6, options: d.options, labels: d.labels }
  const byName = new Map(d.containers.map(c => [c.name, c.id]))
  const reconnect = async () => {
    const failed: string[] = []
    for (const c of plan.containers) {
      await p.connectNetwork(ctx.conn, ctx.epId, d.name, byName.get(c.name)!, c.aliases).catch(() => failed.push(c.name))
    }
    return failed
  }
  for (const c of plan.containers) await p.disconnectNetwork(ctx.conn, ctx.epId, d.id, byName.get(c.name)!)
  log.push(`${plan.containers.length} conteneur(s) déconnecté(s)`)
  await p.removeNetwork(ctx.conn, ctx.epId, d.id)
  try {
    await p.createNetworkSpec(ctx.conn, ctx.epId, { ...spec, ipam: { driver: d.ipam.driver, options: d.ipam.options, config: [{ subnet: plan.to! }] } })
    log.push(`Réseau ${d.name} recréé en ${plan.to}`)
  }
  catch (err) {
    // Retour à l'identique : sous-réseau d'origine, conteneurs reconnectés.
    await p.createNetworkSpec(ctx.conn, ctx.epId, { ...spec, ipam: d.ipam })
    const failed = await reconnect()
    throw createError({ statusCode: 502, statusMessage: `Recréation en ${plan.to} impossible (${(err as Error).message.slice(0, 200)}) : réseau d'origine rétabli${failed.length ? ` ; à reconnecter à la main : ${failed.join(', ')}` : ''}` })
  }
  const failed = await reconnect()
  log.push(failed.length ? `Reconnexion en échec pour ${failed.join(', ')} : à reconnecter (docker network connect ${d.name} <conteneur>)` : `${plan.containers.length} conteneur(s) reconnecté(s) avec leurs alias`)
  if (failed.length) throw createError({ statusCode: 502, statusMessage: log.join(' ; ') })
  return log
}


export interface BulkMove { network: string, from: string[], to: string | null, mode: 'redeploy' | 'live' | null, owner: string, error?: string }

/**
 * Déplacement groupé vers la plage de l'endpoint des réseaux surdimensionnés ou en conflit :
 * sous-réseaux calculés en une passe (sans collision), réseaux autonomes et externes déplacés en
 * direct un par un, projets de la console redéployés une seule fois chacun.
 */
export async function moveAll(endpointId: string, user: { id: string | null, email: string }, dryRun: boolean): Promise<{ moves: BulkMove[], deployments: string[] }> {
  const ctx = await endpointCtx(endpointId)
  const pool = ctx.ep.networkPool
  const base = pool ? parseCidr(pool.base) : null
  if (!pool || !base) throw createError({ statusCode: 409, statusMessage: 'Définir d\'abord la plage d\'adresses de l\'endpoint' })
  const plan = await addressPlan(endpointId)
  const todo = plan.networks.filter(n => n.movable && n.issues.length > 0 && !n.inPool)
  const pinned = await db().select({ subnet: schema.networkAllocations.subnet }).from(schema.networkAllocations).where(eq(schema.networkAllocations.endpointId, endpointId))
  const taken = [...plan.networks.filter(n => !todo.includes(n)).flatMap(n => n.subnets), ...pinned.map(p => p.subnet), ...pool.avoid].map(parseCidr).filter((c): c is Cidr => !!c)
  const moves: BulkMove[] = todo.map((n) => {
    const to = firstFree(base, pool.prefix, taken)
    if (to) taken.push(to)
    const owner = n.owner.kind === 'project' ? `${n.owner.project} (${n.owner.environment})` : n.owner.stack ?? n.owner.kind
    return { network: n.name, from: n.subnets, to: to?.text ?? null, mode: n.moveMode, owner, ...(to ? {} : { error: `Plage ${pool.base} épuisée` }) }
  })
  if (dryRun) return { moves, deployments: [] }

  const toRedeploy = new Set<string>()
  for (const m of moves.filter(x => x.to && !x.error)) {
    try {
      const { net, plan: p } = await planMove(endpointId, { network: m.network, subnet: m.to, dryRun: true })
      if (p.blockers.length) throw new Error(p.blockers.join(' ; '))
      if (p.mode === 'redeploy') {
        await pinSubnet(endpointId, net.owner.targetId!, net.owner.network!, m.to!)
        toRedeploy.add(net.owner.targetId!)
      }
      else {
        await moveNetwork(endpointId, { network: m.network, subnet: m.to, dryRun: false }, user)
      }
    }
    catch (err) {
      m.error = (err as { statusMessage?: string, message?: string }).statusMessage ?? (err as Error).message
    }
  }
  const deployments: string[] = []
  for (const targetId of toRedeploy) {
    const t = await getTargetOr404(targetId)
    try {
      deployments.push(await createLifecycleAction(t, 'redeploy', user.id, `net-move-all:${targetId}:${Date.now()}`))
    }
    catch (err) {
      for (const m of moves.filter(x => x.owner.startsWith(t.project.name))) m.error = `Redéploiement impossible : ${(err as { statusMessage?: string }).statusMessage ?? (err as Error).message}`
    }
  }
  return { moves, deployments }
}
