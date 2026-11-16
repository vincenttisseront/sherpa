import { eq } from 'drizzle-orm'
import { db, schema } from '../../../db/client'
import { requirePermission } from '../../../utils/auth'
import { idParam } from '../../../utils/validation'

defineRouteMeta({ openAPI: { tags: ['admin'], summary: 'Membres d\'un groupe' } })

export default defineEventHandler(async (event) => {
  await requirePermission(event, 'group:manage')
  const { id } = await getValidatedRouterParams(event, idParam.parse)
  const [g] = await db().select().from(schema.groups).where(eq(schema.groups.id, id))
  if (!g) throw createError({ statusCode: 404, statusMessage: 'Groupe introuvable' })
  const members = await db().select({ id: schema.users.id, email: schema.users.email, displayName: schema.users.displayName, kind: schema.users.kind, fromIdp: schema.userGroups.fromIdp })
    .from(schema.userGroups).innerJoin(schema.users, eq(schema.users.id, schema.userGroups.userId)).where(eq(schema.userGroups.groupId, id))
  return { id: g.id, name: g.name, description: g.description, members }
})
