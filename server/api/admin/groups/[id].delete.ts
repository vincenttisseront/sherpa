import { and, eq } from 'drizzle-orm'
import { db, schema } from '../../../db/client'
import { audit } from '../../../utils/audit'
import { clientIp, requirePermission } from '../../../utils/auth'
import { idParam } from '../../../utils/validation'
import { globalAdminUserIds } from '../../../services/admin'

defineRouteMeta({ openAPI: { tags: ['admin'], summary: 'Supprime un groupe (et ses attributions de rôles)' } })

export default defineEventHandler(async (event) => {
  const actor = await requirePermission(event, 'group:manage')
  const { id } = await getValidatedRouterParams(event, idParam.parse)
  const [g] = await db().select().from(schema.groups).where(eq(schema.groups.id, id))
  if (!g) throw createError({ statusCode: 404, statusMessage: 'Groupe introuvable' })
  await db().transaction(async (tx) => {
    await tx.delete(schema.roleBindings).where(and(eq(schema.roleBindings.subjectType, 'group'), eq(schema.roleBindings.subjectId, id)))
    await tx.delete(schema.groups).where(eq(schema.groups.id, id))
    if (!(await globalAdminUserIds(tx)).length) throw createError({ statusCode: 409, statusMessage: 'Ce groupe porte le dernier administrateur : suppression refusée' })
  })
  await audit({ actorUserId: actor.id, actorLabel: actor.email, action: 'group.delete', targetType: 'group', targetId: id, outcome: 'success', ip: clientIp(event), details: { name: g.name } })
  return { ok: true }
})
