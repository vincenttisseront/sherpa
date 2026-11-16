import { groupInput } from '../../../../shared/schemas/admin'
import { db, schema } from '../../../db/client'
import { audit } from '../../../utils/audit'
import { clientIp, requirePermission } from '../../../utils/auth'
import { pgCode, readValidated, validationError } from '../../../utils/validation'

defineRouteMeta({ openAPI: { tags: ['admin'], summary: 'Crée un groupe' } })

export default defineEventHandler(async (event) => {
  const actor = await requirePermission(event, 'group:manage')
  const input = await readValidated(event, groupInput)
  const [g] = await db().insert(schema.groups).values(input).returning().catch((err) => {
    if (pgCode(err) === '23505') throw validationError({ name: 'Nom déjà utilisé' })
    throw err
  })
  await audit({ actorUserId: actor.id, actorLabel: actor.email, action: 'group.create', targetType: 'group', targetId: g!.id, outcome: 'success', ip: clientIp(event), details: input })
  setResponseStatus(event, 201)
  return { id: g!.id }
})
