import { eq } from 'drizzle-orm'
import { bindingInput } from '../../../../shared/schemas/admin'
import { db, schema } from '../../../db/client'
import { audit } from '../../../utils/audit'
import { clientIp, requirePermission } from '../../../utils/auth'
import { readValidated, validationError } from '../../../utils/validation'
import { environmentMaps } from '../../../services/servers'

defineRouteMeta({ openAPI: { tags: ['admin'], summary: 'Attribue un rôle à un utilisateur ou un groupe, dans une portée (serveur, environnement, projet)' } })

export default defineEventHandler(async (event) => {
  const actor = await requirePermission(event, 'role:manage')
  const input = await readValidated(event, bindingInput)
  const subjectExists = input.subjectType === 'user'
    ? await db().$count(schema.users, eq(schema.users.id, input.subjectId))
    : await db().$count(schema.groups, eq(schema.groups.id, input.subjectId))
  if (!subjectExists) throw validationError({ subjectId: 'Sujet introuvable' })
  const { idByKey } = await environmentMaps()
  const [b] = await db().insert(schema.roleBindings).values({
    roleId: input.roleId, subjectType: input.subjectType, subjectId: input.subjectId,
    serverId: input.serverId, projectId: input.projectId,
    environmentId: input.environmentKey ? idByKey.get(input.environmentKey)! : null,
    createdBy: actor.id,
  }).returning()
  await audit({ actorUserId: actor.id, actorLabel: actor.email, action: 'permissions.grant', targetType: input.subjectType, targetId: input.subjectId, serverId: input.serverId, projectId: input.projectId, outcome: 'success', ip: clientIp(event), details: input })
  setResponseStatus(event, 201)
  return { id: b!.id }
})
