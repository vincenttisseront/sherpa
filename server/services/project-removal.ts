/**
 * Fin de vie d'un projet, deux voies :
 * - suppression définitive : stacks supprimées des hôtes (releases et images construites
 *   comprises), puis projet retiré de la plateforme ; données runtime conservées ;
 * - détachement : la plateforme cesse de gérer le projet, rien n'est touché sur les hôtes
 *   (conteneurs, Compose en service, images) ; la stack redevient externe (reprenable).
 */
import { and, eq, inArray } from 'drizzle-orm'
import { createError } from 'h3'
import type { ProjectRemovalPlan } from '../../shared/schemas/project-removal'
import { ACTIVE_STATUSES } from '../../shared/utils/deployment-status'
import { portainer } from '../adapters/portainer'
import { db, schema } from '../db/client'
import { WATCHTOWER_SERVICE } from '../lib/compose/analyze'
import { projectLayout } from '../utils/path-guard'
import { createLifecycleAction } from './deploy-requests'
import { stackOfTarget } from './diagnostic'
import { getTargetOr404 } from './projects'
import { connectionFor } from './servers'
import { applyProfile, excludeDetachedStack } from './watchtower-profiles'

async function targetsOf(projectId: string) {
  const rows = await db().select({ id: schema.projectTargets.id }).from(schema.projectTargets).where(eq(schema.projectTargets.projectId, projectId))
  return Promise.all(rows.map(r => getTargetOr404(r.id)))
}

async function assertIdle(targetIds: string[]) {
  if (!targetIds.length) return
  const busy = await db().$count(schema.deployments, and(inArray(schema.deployments.targetId, targetIds), inArray(schema.deployments.status, [...ACTIVE_STATUSES])))
  if (busy) throw createError({ statusCode: 409, statusMessage: 'Une opération est en cours sur ce projet : attendre sa fin' })
}

/** Ce que chaque voie fera, cible par cible. */
export async function removalPlan(projectId: string): Promise<ProjectRemovalPlan> {
  const [p] = await db().select().from(schema.projects).where(eq(schema.projects.id, projectId))
  if (!p) throw createError({ statusCode: 404, statusMessage: 'Projet introuvable' })
  const targets = await targetsOf(projectId)
  return {
    projectId,
    slug: p.slug,
    targets: await Promise.all(targets.map(async (t) => {
      const [paths] = await db().select().from(schema.pathConfigs).where(and(eq(schema.pathConfigs.endpointId, t.endpoint.id), eq(schema.pathConfigs.environmentId, t.env.id)))
      const [rel] = t.target.currentReleaseId ? await db().select({ slug: schema.releases.slug }).from(schema.releases).where(eq(schema.releases.id, t.target.currentReleaseId)) : []
      const layout = paths ? (() => {
        try {
          return projectLayout(paths, t.project.slug, t.target.projectPath)
        }
        catch {
          return null
        }
      })() : null
      return {
        targetId: t.target.id,
        environment: t.env.name,
        server: `${t.server.name} / ${t.endpoint.name}`,
        stack: t.target.portainerStackId ? stackOfTarget(t) : null,
        composeFile: layout && rel?.slug ? layout.release(rel.slug).composeFile : null,
        dataDir: layout?.runtimeDir ?? null,
        watchtower: !!t.target.watchtowerApplied,
        secretVariables: !!t.target.envSecretId,
      }
    })),
  }
}

/** Retire le projet de la plateforme (cibles, releases, déploiements, variables chiffrées). */
async function forgetProject(projectId: string) {
  const targets = await db().select({ envSecretId: schema.projectTargets.envSecretId }).from(schema.projectTargets).where(eq(schema.projectTargets.projectId, projectId))
  const secrets = targets.map(t => t.envSecretId).filter((x): x is string => !!x)
  await db().transaction(async (tx) => {
    await tx.delete(schema.projects).where(eq(schema.projects.id, projectId))
    if (secrets.length) await tx.delete(schema.secrets).where(inArray(schema.secrets.id, secrets))
  })
}

/** Détachement : rien n'est modifié sur les hôtes, sauf le Watchtower de la plateforme si demandé. */
export async function detachProject(projectId: string, opts: { stopWatchtower: boolean }): Promise<ProjectRemovalPlan & { watchtowerStopped: string[] }> {
  const plan = await removalPlan(projectId)
  await assertIdle(plan.targets.map(t => t.targetId))
  const stopped: string[] = []
  const profilesToApply = new Set<string>()
  if (opts.stopWatchtower) {
    for (const t of await targetsOf(projectId)) {
      if (!t.target.watchtowerApplied || !t.target.portainerStackId) continue
      // Watchtower d'un profil du serveur : la stack est exclue du profil (réappliqué après le retrait du projet).
      const profileId = (t.target.watchtowerApplied as { profileId?: string | null }).profileId
      if (profileId) {
        await excludeDetachedStack(profileId, stackOfTarget(t))
        profilesToApply.add(profileId)
        stopped.push(`${stackOfTarget(t)} (exclue du profil Watchtower)`)
        continue
      }
      const [server] = await db().select().from(schema.portainerServers).where(eq(schema.portainerServers.id, t.server.id))
      const conn = await connectionFor(server!)
      const epId = t.endpoint.portainerEndpointId
      for (const c of (await portainer().stackContainers(conn, epId, stackOfTarget(t))).filter(x => x.service === WATCHTOWER_SERVICE)) {
        await portainer().stopContainer(conn, epId, c.id).catch(() => {})
        await portainer().removeContainer(conn, epId, c.id)
        stopped.push(c.name)
      }
    }
  }
  await forgetProject(projectId)
  for (const id of profilesToApply) await applyProfile(id).catch(err => console.warn(`[détachement] profil Watchtower ${id} non réappliqué : ${(err as Error).message}`))
  return { ...plan, watchtowerStopped: stopped }
}

/**
 * Suppression définitive : suppression de chaque stack (opérations auditées), le projet
 * étant retiré à la fin de la dernière ; sans stack, retiré tout de suite.
 */
export async function deleteProjectDefinitively(projectId: string, userId: string | null, key: string): Promise<{ deploymentIds: string[], removed: boolean }> {
  const targets = await targetsOf(projectId)
  await assertIdle(targets.map(t => t.target.id))
  const deployed = targets.filter(t => t.target.portainerStackId)
  if (!deployed.length) {
    await forgetProject(projectId)
    return { deploymentIds: [], removed: true }
  }
  const ids: string[] = []
  for (const t of deployed) ids.push(await createLifecycleAction(t, 'delete', userId, `delete-project:${t.target.id}:${key}`, { deleteProject: true }))
  return { deploymentIds: ids, removed: false }
}

/** Appelé à la fin d'une suppression de stack demandée par une suppression définitive. */
export async function finishProjectDeletion(projectId: string): Promise<boolean> {
  const targets = await db().select({ id: schema.projectTargets.id, stack: schema.projectTargets.portainerStackId }).from(schema.projectTargets).where(eq(schema.projectTargets.projectId, projectId))
  if (targets.some(t => t.stack)) return false
  const busy = await db().$count(schema.deployments, and(inArray(schema.deployments.targetId, targets.map(t => t.id)), inArray(schema.deployments.status, [...ACTIVE_STATUSES])))
  if (busy) return false
  await forgetProject(projectId)
  return true
}
