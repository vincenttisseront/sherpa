import { eq } from 'drizzle-orm'
import { mappingsInput } from '../../../../../shared/schemas/admin'
import { db, schema } from '../../../../db/client'
import { audit } from '../../../../utils/audit'
import { clientIp, requirePermission } from '../../../../utils/auth'
import { idParam, readValidated } from '../../../../utils/validation'

defineRouteMeta({ openAPI: { tags: ['admin'], summary: 'Remplace les mappings groupe IdP → groupe interne (appliqués à la prochaine connexion)' } })

export default defineEventHandler(async (event) => {
  const actor = await requirePermission(event, 'group:manage')
  const { id } = await getValidatedRouterParams(event, idParam.parse)
  const input = await readValidated(event, mappingsInput)
  await db().transaction(async (tx) => {
    await tx.delete(schema.idpGroupMappings).where(eq(schema.idpGroupMappings.idpId, id))
    if (input.length) await tx.insert(schema.idpGroupMappings).values(input.map(m => ({ ...m, idpId: id }))).onConflictDoNothing()
  })
  await audit({ actorUserId: actor.id, actorLabel: actor.email, action: 'permissions.idp_mappings', targetType: 'identity_provider', targetId: id, outcome: 'success', ip: clientIp(event), details: { mappings: input } })
  return { ok: true }
})
