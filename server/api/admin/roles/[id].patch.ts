import { eq } from 'drizzle-orm'
import { roleInput } from '../../../../shared/schemas/admin'
import { PERMISSIONS } from '../../../../shared/utils/permissions'
import { db, schema } from '../../../db/client'
import { audit } from '../../../utils/audit'
import { clientIp, requirePermission } from '../../../utils/auth'
import { idParam, readValidated, validationError } from '../../../utils/validation'

defineRouteMeta({ openAPI: { tags: ['admin'], summary: 'Modifie un rôle personnalisé (les rôles intégrés sont figés)' } })

export default defineEventHandler(async (event) => {
  const actor = await requirePermission(event, 'role:manage')
  const { id } = await getValidatedRouterParams(event, idParam.parse)
  const input = await readValidated(event, roleInput.omit({ key: true }))
  const [r] = await db().select().from(schema.roles).where(eq(schema.roles.id, id))
  if (!r) throw createError({ statusCode: 404, statusMessage: 'Rôle introuvable' })
  if (r.builtin) throw createError({ statusCode: 409, statusMessage: 'Rôle intégré : non modifiable (créer un rôle personnalisé)' })
  const unknown = input.permissions.filter(p => !(PERMISSIONS as readonly string[]).includes(p))
  if (unknown.length) throw validationError({ permissions: `Permissions inconnues : ${unknown.join(', ')}` })
  await db().update(schema.roles).set(input).where(eq(schema.roles.id, id))
  await audit({ actorUserId: actor.id, actorLabel: actor.email, action: 'permissions.role_update', targetType: 'role', targetId: id, outcome: 'success', ip: clientIp(event), details: { before: r.permissions, after: input.permissions } })
  return { ok: true }
})
