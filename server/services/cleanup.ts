/**
 * Nettoyage Docker d'un endpoint : conteneurs arrêtés, images, volumes et réseaux
 * inutilisés, cache de build. Ce que la plateforme gère est toujours protégé :
 * - conteneurs des stacks déployées (une stack arrêtée doit pouvoir redémarrer) ;
 * - images construites par la plateforme (rollback ; rétention par environnement) ;
 * - volumes des stacks de la plateforme (données runtime des projets) ;
 * - réseaux déclarés dans la plateforme (Traefik, réseaux autorisés) et des stacks.
 * Le serveur recalcule les candidats à l'exécution : la sélection du client ne
 * peut qu'en retirer, jamais ajouter. Refusé pendant une opération sur l'endpoint.
 */
import { type Progress, noProgress } from '../utils/progress'
import { and, eq, inArray } from 'drizzle-orm'
import { createError } from 'h3'
import type { CleanupInput, CleanupItem, CleanupPreview, CleanupResult, CleanupStepResult } from '../../shared/schemas/cleanup'
import { ACTIVE_STATUSES } from '../../shared/utils/deployment-status'
import { portainer } from '../adapters/portainer'
import { db, schema } from '../db/client'
import { acquireLock } from '../queue/lock'
import { redis } from '../queue/redis'
import { audit } from '../utils/audit'
import type { AuthUser } from '../utils/auth'
import { connectionFor } from './servers'

type EndpointRow = { ep: typeof schema.serverEndpoints.$inferSelect, server: typeof schema.portainerServers.$inferSelect }
const DEFAULT_NETWORKS = new Set(['bridge', 'host', 'none', 'ingress', 'docker_gwbridge'])
const COMPOSE_PROJECT = 'com.docker.compose.project'
const short = (id: string) => id.replace(/^sha256:/, '').slice(0, 12)

async function platformContext(endpointId: string) {
  const [stacks, nets, busy] = await Promise.all([
    db().select({ stack: schema.projectTargets.stackName }).from(schema.projectTargets).where(eq(schema.projectTargets.endpointId, endpointId)),
    db().select({ name: schema.networks.name, policy: schema.networks.policy }).from(schema.networks).where(eq(schema.networks.endpointId, endpointId)),
    db().select({ id: schema.deployments.id, action: schema.deployments.action, project: schema.projects.name }).from(schema.deployments)
      .innerJoin(schema.projectTargets, eq(schema.projectTargets.id, schema.deployments.targetId))
      .innerJoin(schema.projects, eq(schema.projects.id, schema.projectTargets.projectId))
      .where(and(eq(schema.projectTargets.endpointId, endpointId), inArray(schema.deployments.status, [...ACTIVE_STATUSES]))).limit(1),
  ])
  // Projets existants ayant une cible sur cet endpoint : leurs images restent protégées.
  const projects = await db().select({ slug: schema.projects.slug }).from(schema.projectTargets)
    .innerJoin(schema.projects, eq(schema.projects.id, schema.projectTargets.projectId)).where(eq(schema.projectTargets.endpointId, endpointId))
  const traefik = await db().select({ network: schema.traefikConfigs.networkName }).from(schema.traefikConfigs).where(eq(schema.traefikConfigs.endpointId, endpointId))
  return {
    stacks: new Set(stacks.map(s => s.stack).filter((s): s is string => !!s)),
    projects: new Set(projects.map(p => p.slug)),
    declaredNetworks: new Set([...nets.filter(n => n.policy === 'allowed').map(n => n.name), ...traefik.map(t => t.network)]),
    busy: busy[0] ? `${busy[0].project} : opération en cours` : null,
  }
}

export async function previewCleanup(row: EndpointRow, progress: Progress = noProgress): Promise<CleanupPreview> {
  await progress.step('Lecture de l\'occupation disque, des conteneurs et des réseaux (docker system df)')
  const conn = await connectionFor(row.server)
  const p = portainer()
  const ep = row.ep.portainerEndpointId
  const [ctx, df, containers, networks] = await Promise.all([
    platformContext(row.ep.id),
    p.diskUsage(conn, ep),
    p.listContainers(conn, ep),
    p.listNetworksDetailed(conn, ep),
  ])
  const ofPlatformStack = (labels: Record<string, string>) => !!labels[COMPOSE_PROJECT] && ctx.stacks.has(labels[COMPOSE_PROJECT]!)

  const stopped: CleanupItem[] = containers.filter(c => !['running', 'restarting', 'paused'].includes(c.state)).map(c => ({
    id: c.id, name: c.names[0] ?? short(c.id), detail: `${c.image} · ${c.status}`, sizeBytes: null,
    protectedBy: c.labels['platform.managed'] === 'true' || ofPlatformStack(c.labels) ? 'Stack déployée par la plateforme' : null,
  }))

  const imageItem = (i: (typeof df.images)[number]): CleanupItem => ({
    id: i.id, name: i.tags[0] ?? `<sans tag> ${short(i.id)}`, detail: i.labels['platform.project'] && !ctx.projects.has(i.labels['platform.project']) ? `projet supprimé : ${i.labels['platform.project']}` : i.tags.length > 1 ? `${i.tags.length} tags` : null, sizeBytes: i.sizeBytes,
    platformProject: i.labels['platform.project'] ?? null,
    // Images d'un projet existant : rollback et rétention par environnement. Celles d'un projet supprimé sont libres.
    protectedBy: i.labels['platform.project'] && ctx.projects.has(i.labels['platform.project']) ? 'Image construite par la plateforme (rollback, rétention par environnement)' : null,
  })
  const unusedImages = df.images.filter(i => i.containers === 0)

  const usedNetworks = new Set(containers.flatMap(c => c.networks))
  const netItems: CleanupItem[] = networks.filter(n => !DEFAULT_NETWORKS.has(n.name) && !usedNetworks.has(n.name) && n.scope === 'local').map(n => ({
    id: n.id, name: n.name, detail: n.driver, sizeBytes: null,
    protectedBy: ctx.declaredNetworks.has(n.name) ? 'Réseau déclaré dans la plateforme' : ofPlatformStack(n.labels) ? 'Réseau d\'une stack de la plateforme' : null,
  }))

  const volItems: CleanupItem[] = df.volumes.filter(v => v.refCount === 0).map(v => ({
    id: v.name, name: v.name, detail: v.labels[COMPOSE_PROJECT] ? `stack ${v.labels[COMPOSE_PROJECT]}` : /^[0-9a-f]{64}$/.test(v.name) ? 'volume anonyme' : v.driver, sizeBytes: v.sizeBytes,
    protectedBy: ofPlatformStack(v.labels) ? 'Données d\'une stack de la plateforme' : null,
  }))

  return {
    endpointId: row.ep.id,
    scannedAt: new Date().toISOString(),
    busy: ctx.busy,
    usage: df.usage,
    containers: stopped,
    images: { dangling: unusedImages.filter(i => i.dangling).map(imageItem), unused: unusedImages.filter(i => !i.dangling).map(imageItem) },
    volumes: volItems,
    networks: netItems,
    buildCache: { count: df.usage.buildCache.count, reclaimableBytes: df.usage.buildCache.reclaimableBytes },
  }
}

export async function runCleanup(row: EndpointRow, input: CleanupInput, user: AuthUser, progress: Progress = noProgress): Promise<CleanupResult> {
  const lock = await acquireLock(redis(), `lock:cleanup:${row.ep.id}`, 10 * 60_000)
  if (!lock) throw createError({ statusCode: 409, statusMessage: 'Un nettoyage est déjà en cours sur cet endpoint' })
  try {
    const chosen = (['containers', 'images', 'volumes', 'networks', 'buildCache'] as const).filter(k => input[k])
    const total = chosen.length + 1
    await progress.step('Vérification des candidats et des protections', 1, total)
    const preview = await previewCleanup(row)
    if (preview.busy) throw createError({ statusCode: 409, statusMessage: `Nettoyage refusé pendant une opération (${preview.busy})` })
    const conn = await connectionFor(row.server)
    const p = portainer()
    const ep = row.ep.portainerEndpointId
    const steps: CleanupStepResult[] = []
    const LABEL = { containers: 'Suppression des conteneurs arrêtés', images: 'Suppression des images inutilisées', volumes: 'Suppression des volumes sélectionnés', networks: 'Suppression des réseaux sélectionnés', buildCache: 'Purge du cache de build' } as const
    const step = async (action: CleanupStepResult['action'], fn: () => Promise<{ deleted: number, reclaimedBytes: number, errors?: string[] }>) => {
      await progress.step(LABEL[action], chosen.indexOf(action) + 2, total)
      try {
        const r = await fn()
        steps.push({ action, deleted: r.deleted, reclaimedBytes: r.reclaimedBytes, errors: r.errors ?? [] })
      }
      catch (err) {
        steps.push({ action, deleted: 0, reclaimedBytes: 0, errors: [(err as Error).message] })
      }
    }

    if (input.containers) {
      await step('containers', async () => {
        // Une seule valeur « label! » : avec plusieurs, Docker n'exclut que les conteneurs portant TOUS les labels.
        // Tout service déployé par la plateforme porte platform.managed=true.
        const filters: Record<string, string[]> = { 'label!': ['platform.managed=true'] }
        if (input.containers!.olderThan24h) filters.until = ['24h']
        const r = await p.pruneContainers(conn, ep, filters)
        return { deleted: r.deleted.length, reclaimedBytes: r.reclaimedBytes }
      })
    }
    if (input.images) {
      await step('images', async () => {
        const r = await p.pruneImages(conn, ep, { dangling: [input.images!.mode === 'dangling' ? 'true' : 'false'], 'label!': ['platform.project'] })
        // Images de projets supprimés : hors du filtre ci-dessus, retirées une à une.
        const orphans = [...preview.images.dangling, ...(input.images!.mode === 'unused' ? preview.images.unused : [])]
          .filter(i => !i.protectedBy && i.platformProject)
        const errors: string[] = []
        let deleted = r.deleted.length
        let bytes = r.reclaimedBytes
        for (const i of orphans) {
          try {
            await p.removeImage(conn, ep, i.id)
            deleted++
            bytes += i.sizeBytes ?? 0
          }
          catch (err) {
            errors.push(`${i.name} : ${(err as Error).message}`)
          }
        }
        return { deleted, reclaimedBytes: bytes, errors }
      })
    }
    if (input.volumes) {
      await step('volumes', async () => {
        // Seuls les volumes encore inutilisés et non protégés au moment de l'exécution.
        const allowed = new Map(preview.volumes.filter(v => !v.protectedBy).map(v => [v.id, v]))
        const errors: string[] = []
        let deleted = 0
        let bytes = 0
        for (const name of input.volumes!.names) {
          const v = allowed.get(name)
          if (!v) {
            errors.push(`${name} : protégé ou de nouveau utilisé, conservé`)
            continue
          }
          try {
            await p.removeVolume(conn, ep, name)
            deleted++
            bytes += v.sizeBytes ?? 0
          }
          catch (err) {
            errors.push(`${name} : ${(err as Error).message}`)
          }
        }
        return { deleted, reclaimedBytes: bytes, errors }
      })
    }
    if (input.networks) {
      await step('networks', async () => {
        const allowed = new Set(preview.networks.filter(n => !n.protectedBy).map(n => n.id))
        const errors: string[] = []
        let deleted = 0
        for (const id of input.networks!.ids) {
          if (!allowed.has(id)) {
            errors.push(`${preview.networks.find(n => n.id === id)?.name ?? id.slice(0, 12)} : protégé ou de nouveau utilisé, conservé`)
            continue
          }
          try {
            await p.removeNetwork(conn, ep, id)
            deleted++
          }
          catch (err) {
            errors.push(`${preview.networks.find(n => n.id === id)?.name ?? id.slice(0, 12)} : ${(err as Error).message}`)
          }
        }
        return { deleted, reclaimedBytes: 0, errors }
      })
    }
    if (input.buildCache) {
      await step('buildCache', async () => {
        const r = await p.pruneBuildCache(conn, ep, { all: true, ...(input.buildCache!.olderThan24h ? { until: '24h' } : {}) })
        return { deleted: r.deleted.length, reclaimedBytes: r.reclaimedBytes }
      })
    }
    const reclaimedBytes = steps.reduce((a, s) => a + s.reclaimedBytes, 0)
    await audit({
      actorUserId: user.id, actorLabel: user.email, action: 'docker.cleanup', targetType: 'endpoint', targetId: row.ep.id, serverId: row.server.id,
      outcome: steps.some(s => s.errors.length && !s.deleted) ? 'failure' : 'success',
      details: { endpoint: row.ep.name, request: input, reclaimedBytes, steps: steps.map(s => ({ action: s.action, deleted: s.deleted, reclaimedBytes: s.reclaimedBytes, errors: s.errors.length })) },
    })
    return { reclaimedBytes, steps }
  }
  finally {
    await lock.release()
  }
}
