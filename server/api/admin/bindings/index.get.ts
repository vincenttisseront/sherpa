import { and, eq } from 'drizzle-orm'
import { z } from 'zod'
import { db, schema } from '../../../db/client'
import { requireAnyPermission } from '../../../utils/auth'

defineRouteMeta({ openAPI: { tags: ['admin'], summary: 'Attributions de rôles (filtrables par sujet), avec leur portée lisible' } })

export default defineEventHandler(async (event) => {
  await requireAnyPermission(event, 'role:manage')
  const q = await getValidatedQuery(event, z.object({ subjectType: z.enum(['user', 'group']).optional(), subjectId: z.uuid().optional() }).parse)
  const b = schema.roleBindings
  const rows = await db().select({ b, role: { key: schema.roles.key, name: schema.roles.name }, server: schema.portainerServers.name, env: schema.environments.key, project: schema.projects.slug })
    .from(b).innerJoin(schema.roles, eq(schema.roles.id, b.roleId))
    .leftJoin(schema.portainerServers, eq(schema.portainerServers.id, b.serverId))
    .leftJoin(schema.environments, eq(schema.environments.id, b.environmentId))
    .leftJoin(schema.projects, eq(schema.projects.id, b.projectId))
    .where(and(...(q.subjectType ? [eq(b.subjectType, q.subjectType)] : []), ...(q.subjectId ? [eq(b.subjectId, q.subjectId)] : [])))
  const users = new Map((await db().select({ id: schema.users.id, email: schema.users.email }).from(schema.users)).map(u => [u.id, u.email]))
  const groups = new Map((await db().select({ id: schema.groups.id, name: schema.groups.name }).from(schema.groups)).map(g => [g.id, g.name]))
  return rows.map(r => ({
    id: r.b.id, role: r.role, subjectType: r.b.subjectType, subjectId: r.b.subjectId,
    subject: r.b.subjectType === 'user' ? users.get(r.b.subjectId) ?? '?' : groups.get(r.b.subjectId) ?? '?',
    scope: { server: r.server, environment: r.env, project: r.project }, createdAt: r.b.createdAt.toISOString(),
  }))
})
