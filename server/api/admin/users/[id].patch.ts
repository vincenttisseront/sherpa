import { eq } from 'drizzle-orm'
import { userPatchInput } from '../../../../shared/schemas/admin'
import { revokeUserSessions } from '../../../auth/sessions'
import { db, schema } from '../../../db/client'
import { audit } from '../../../utils/audit'
import { clientIp, requirePermission } from '../../../utils/auth'
import { idParam, readValidated } from '../../../utils/validation'
import { assertAdminsRemain, globalAdminUserIds } from '../../../services/admin'

defineRouteMeta({ openAPI: { tags: ['admin'], summary: 'Modifie un utilisateur : nom, suspension/réactivation, expiration (sessions révoquées à la suspension)' } })

export default defineEventHandler(async (event) => {
  const actor = await requirePermission(event, 'user:manage')
  const { id } = await getValidatedRouterParams(event, idParam.parse)
  const patch = await readValidated(event, userPatchInput)
  const [u] = await db().select().from(schema.users).where(eq(schema.users.id, id))
  if (!u) throw createError({ statusCode: 404, statusMessage: 'Utilisateur introuvable' })
  if (patch.status === 'suspended') {
    if (id === actor.id) throw createError({ statusCode: 409, statusMessage: 'Impossible de suspendre son propre compte' })
    await assertAdminsRemain(async () => (await globalAdminUserIds()).filter(x => x !== id))
  }
  if (patch.status === 'active' && u.status === 'invited') throw createError({ statusCode: 409, statusMessage: 'Le compte s\'activera à l\'acceptation de l\'invitation' })
  await db().update(schema.users).set({
    ...(patch.displayName ? { displayName: patch.displayName } : {}),
    ...(patch.status ? { status: patch.status } : {}),
    ...(patch.expiresAt !== undefined ? { expiresAt: patch.expiresAt ? new Date(patch.expiresAt) : null } : {}),
  }).where(eq(schema.users.id, id))
  const revoked = patch.status === 'suspended' ? await revokeUserSessions(id) : 0
  await audit({ actorUserId: actor.id, actorLabel: actor.email, action: patch.status === 'suspended' ? 'user.suspend' : patch.status === 'active' ? 'user.reactivate' : 'user.update', targetType: 'user', targetId: id, outcome: 'success', ip: clientIp(event), details: { email: u.email, ...patch, revokedSessions: revoked } })
  return { ok: true, revokedSessions: revoked }
})
