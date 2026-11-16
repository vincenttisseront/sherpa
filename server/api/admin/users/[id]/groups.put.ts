import { and, eq } from 'drizzle-orm'
import { z } from 'zod'
import { db, schema } from '../../../../db/client'
import { audit } from '../../../../utils/audit'
import { clientIp, requirePermission } from '../../../../utils/auth'
import { idParam, readValidated } from '../../../../utils/validation'
import { globalAdminUserIds } from '../../../../services/admin'

defineRouteMeta({ openAPI: { tags: ['admin'], summary: 'Groupes attribués manuellement (les groupes issus du SSO sont gérés par l\'IdP)' } })

export default defineEventHandler(async (event) => {
  const actor = await requirePermission(event, 'group:manage')
  const { id } = await getValidatedRouterParams(event, idParam.parse)
  const groupIds = await readValidated(event, z.array(z.uuid()).max(100))
  const before = await db().select().from(schema.userGroups).where(and(eq(schema.userGroups.userId, id), eq(schema.userGroups.fromIdp, false)))
  await db().transaction(async (tx) => {
    await tx.delete(schema.userGroups).where(and(eq(schema.userGroups.userId, id), eq(schema.userGroups.fromIdp, false)))
    if (groupIds.length) await tx.insert(schema.userGroups).values(groupIds.map(groupId => ({ userId: id, groupId }))).onConflictDoNothing()
    // Vérifié dans la transaction : annule si plus aucun administrateur.
    const admins = await globalAdminUserIds(tx)
    if (!admins.length) throw createError({ statusCode: 409, statusMessage: 'La plateforme doit conserver au moins un administrateur actif' })
  })
  await audit({ actorUserId: actor.id, actorLabel: actor.email, action: 'permissions.groups', targetType: 'user', targetId: id, outcome: 'success', ip: clientIp(event), details: { before: before.map(b => b.groupId), after: groupIds } })
  return { ok: true }
})
