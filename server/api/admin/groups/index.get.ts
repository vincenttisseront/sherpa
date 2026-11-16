import { asc, count, eq } from 'drizzle-orm'
import { db, schema } from '../../../db/client'
import { requireAnyPermission } from '../../../utils/auth'

defineRouteMeta({ openAPI: { tags: ['admin'], summary: 'Groupes et nombre de membres' } })

export default defineEventHandler(async (event) => {
  await requireAnyPermission(event, 'group:manage')
  const rows = await db().select({ g: schema.groups, members: count(schema.userGroups.userId) }).from(schema.groups)
    .leftJoin(schema.userGroups, eq(schema.userGroups.groupId, schema.groups.id)).groupBy(schema.groups.id).orderBy(asc(schema.groups.name))
  return rows.map(r => ({ id: r.g.id, name: r.g.name, description: r.g.description, members: r.members, createdAt: r.g.createdAt.toISOString() }))
})
