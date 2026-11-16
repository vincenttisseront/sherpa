/** Droits effectifs d'un utilisateur : rôles attribués directement ou via ses groupes, avec leur portée (§16). */
import { and, eq, inArray, or } from 'drizzle-orm'
import type { RoleGrant } from '../../shared/utils/permissions'
import { db, schema } from '../db/client'

export async function userGroupIds(userId: string): Promise<string[]> {
  return (await db().select({ id: schema.userGroups.groupId }).from(schema.userGroups).where(eq(schema.userGroups.userId, userId))).map(g => g.id)
}

export async function loadGrants(userId: string): Promise<RoleGrant[]> {
  const groups = await userGroupIds(userId)
  const rows = await db().select({ permissions: schema.roles.permissions, b: schema.roleBindings })
    .from(schema.roleBindings)
    .innerJoin(schema.roles, eq(schema.roles.id, schema.roleBindings.roleId))
    .where(or(
      and(eq(schema.roleBindings.subjectType, 'user'), eq(schema.roleBindings.subjectId, userId)),
      ...(groups.length ? [and(eq(schema.roleBindings.subjectType, 'group'), inArray(schema.roleBindings.subjectId, groups))] : []),
    ))
  return rows.map(r => ({ permissions: r.permissions, scope: { serverId: r.b.serverId, environmentId: r.b.environmentId, projectId: r.b.projectId } }))
}
