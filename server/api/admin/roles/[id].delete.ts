import { eq } from 'drizzle-orm'
import { db, schema } from '../../../db/client'
import { audit } from '../../../utils/audit'
import { clientIp, requirePermission } from '../../../utils/auth'
import { idParam } from '../../../utils/validation'

defineRouteMeta({ openAPI: { tags: ['admin'], summary: 'Supprime un rôle personnalisé non attribué' } })

export default defineEventHandler(async (event) => {
  const actor = await requirePermission(event, 'role:manage')
  const { id } = await getValidatedRouterParams(event, idParam.parse)
  const [r] = await db().select().from(schema.roles).where(eq(schema.roles.id, id))
  if (!r) throw createError({ statusCode: 404, statusMessage: 'Rôle introuvable' })
  if (r.builtin) throw createError({ statusCode: 409, statusMessage: 'Rôle intégré : non supprimable' })
  const used = await db().$count(schema.roleBindings, eq(schema.roleBindings.roleId, id))
  if (used) throw createError({ statusCode: 409, statusMessage: `Rôle attribué ${used} fois : retirer d'abord ces attributions` })
  await db().delete(schema.roles).where(eq(schema.roles.id, id))
  await audit({ actorUserId: actor.id, actorLabel: actor.email, action: 'permissions.role_delete', targetType: 'role', targetId: id, outcome: 'success', ip: clientIp(event), details: { key: r.key } })
  return { ok: true }
})
