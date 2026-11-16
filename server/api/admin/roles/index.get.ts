import { asc } from 'drizzle-orm'
import { PERMISSIONS } from '../../../../shared/utils/permissions'
import { db, schema } from '../../../db/client'
import { requireAnyPermission } from '../../../utils/auth'

defineRouteMeta({ openAPI: { tags: ['admin'], summary: 'Rôles (intégrés et personnalisés) et catalogue des permissions' } })

export default defineEventHandler(async (event) => {
  await requireAnyPermission(event, 'role:manage')
  const roles = await db().select().from(schema.roles).orderBy(asc(schema.roles.builtin), asc(schema.roles.name))
  return { permissions: PERMISSIONS, roles: roles.map(r => ({ id: r.id, key: r.key, name: r.name, description: r.description, builtin: r.builtin, permissions: r.permissions })) }
})
