/**
 * Filtrage des données selon les portées (§16) : un utilisateur ne voit que
 * les projets, cibles et serveurs couverts par au moins une de ses attributions.
 */
import { eq, inArray } from 'drizzle-orm'
import type { Permission } from '../../shared/utils/permissions'
import { db, schema } from '../db/client'
import { type AuthUser, canOn } from '../utils/auth'

export interface TargetScope { projectId: string, environmentId: string, serverId: string }

export async function targetScopes(projectIds?: string[]): Promise<TargetScope[]> {
  const q = db().select({ projectId: schema.projectTargets.projectId, environmentId: schema.projectTargets.environmentId, serverId: schema.serverEndpoints.serverId })
    .from(schema.projectTargets).innerJoin(schema.serverEndpoints, eq(schema.serverEndpoints.id, schema.projectTargets.endpointId))
  return projectIds ? q.where(inArray(schema.projectTargets.projectId, projectIds)) : q
}

/** Projet visible : permission sur le projet lui-même ou sur l'une de ses cibles. */
export function canOnProject(user: AuthUser, permission: Permission, projectId: string, scopes: TargetScope[]): boolean {
  return canOn(user, permission, { projectId })
    || scopes.filter(s => s.projectId === projectId).some(s => canOn(user, permission, s))
}

/** Identifiants des projets visibles ; null = tous (attribution globale). */
export async function visibleProjectIds(user: AuthUser, permission: Permission): Promise<string[] | null> {
  if (canOn(user, permission, {})) return null
  const projects = await db().select({ id: schema.projects.id }).from(schema.projects)
  const scopes = await targetScopes()
  return projects.map(p => p.id).filter(id => canOnProject(user, permission, id, scopes))
}

/** Serveurs visibles ; null = tous. Une attribution limitée à un environnement ou un projet donne accès aux serveurs qui l'hébergent. */
export async function visibleServerIds(user: AuthUser, permission: Permission): Promise<string[] | null> {
  if (canOn(user, permission, {})) return null
  const servers = await db().select({ id: schema.portainerServers.id }).from(schema.portainerServers)
  const scopes = await targetScopes()
  const endpoints = await db().select({ serverId: schema.serverEndpoints.serverId, environmentId: schema.endpointEnvironments.environmentId })
    .from(schema.endpointEnvironments).innerJoin(schema.serverEndpoints, eq(schema.serverEndpoints.id, schema.endpointEnvironments.endpointId))
  return servers.map(s => s.id).filter(id => canOn(user, permission, { serverId: id })
    || endpoints.some(e => e.serverId === id && canOn(user, permission, { serverId: id, environmentId: e.environmentId }))
    || scopes.some(t => t.serverId === id && canOn(user, permission, t)))
}

/** Cibles visibles ; null = toutes. */
export async function visibleTargetIds(user: AuthUser, permission: Permission): Promise<string[] | null> {
  if (canOn(user, permission, {})) return null
  const rows = await db().select({ id: schema.projectTargets.id, projectId: schema.projectTargets.projectId, environmentId: schema.projectTargets.environmentId, serverId: schema.serverEndpoints.serverId })
    .from(schema.projectTargets).innerJoin(schema.serverEndpoints, eq(schema.serverEndpoints.id, schema.projectTargets.endpointId))
  return rows.filter(r => canOn(user, permission, r)).map(r => r.id)
}
