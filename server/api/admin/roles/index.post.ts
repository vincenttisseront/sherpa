import { roleInput } from '../../../../shared/schemas/admin'
import { PERMISSIONS } from '../../../../shared/utils/permissions'
import { db, schema } from '../../../db/client'
import { audit } from '../../../utils/audit'
import { clientIp, requirePermission } from '../../../utils/auth'
import { pgCode, readValidated, validationError } from '../../../utils/validation'

defineRouteMeta({ openAPI: { tags: ['admin'], summary: 'Crée un rôle personnalisé' } })

export default defineEventHandler(async (event) => {
  const actor = await requirePermission(event, 'role:manage')
  const input = await readValidated(event, roleInput)
  const unknown = input.permissions.filter(p => !(PERMISSIONS as readonly string[]).includes(p))
  if (unknown.length) throw validationError({ permissions: `Permissions inconnues : ${unknown.join(', ')}` })
  const [r] = await db().insert(schema.roles).values({ ...input, builtin: false }).returning().catch((err) => {
    if (pgCode(err) === '23505') throw validationError({ key: 'Identifiant déjà utilisé' })
    throw err
  })
  await audit({ actorUserId: actor.id, actorLabel: actor.email, action: 'permissions.role_create', targetType: 'role', targetId: r!.id, outcome: 'success', ip: clientIp(event), details: input })
  setResponseStatus(event, 201)
  return { id: r!.id }
})
