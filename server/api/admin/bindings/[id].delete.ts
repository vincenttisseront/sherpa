import { eq } from 'drizzle-orm'
import { db, schema } from '../../../db/client'
import { audit } from '../../../utils/audit'
import { clientIp, requirePermission } from '../../../utils/auth'
import { idParam } from '../../../utils/validation'
import { globalAdminUserIds } from '../../../services/admin'

defineRouteMeta({ openAPI: { tags: ['admin'], summary: 'Retire une attribution (refusé si elle porte le dernier administrateur)' } })

export default defineEventHandler(async (event) => {
  const actor = await requirePermission(event, 'role:manage')
  const { id } = await getValidatedRouterParams(event, idParam.parse)
  const [b] = await db().select().from(schema.roleBindings).where(eq(schema.roleBindings.id, id))
  if (!b) throw createError({ statusCode: 404, statusMessage: 'Attribution introuvable' })
  await db().transaction(async (tx) => {
    await tx.delete(schema.roleBindings).where(eq(schema.roleBindings.id, id))
    if (!(await globalAdminUserIds(tx)).length) throw createError({ statusCode: 409, statusMessage: 'Cette attribution porte le dernier administrateur : retrait refusé' })
  })
  await audit({ actorUserId: actor.id, actorLabel: actor.email, action: 'permissions.revoke', targetType: b.subjectType, targetId: b.subjectId, outcome: 'success', ip: clientIp(event), details: { roleId: b.roleId, serverId: b.serverId, environmentId: b.environmentId, projectId: b.projectId } })
  return { ok: true }
})
