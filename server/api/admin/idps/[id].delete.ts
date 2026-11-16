import { eq } from 'drizzle-orm'
import { forgetConfig } from '../../../auth/oidc'
import { db, schema } from '../../../db/client'
import { audit } from '../../../utils/audit'
import { clientIp, requirePermission } from '../../../utils/auth'
import { idParam } from '../../../utils/validation'

defineRouteMeta({ openAPI: { tags: ['admin'], summary: 'Supprime un fournisseur (refusé s\'il a des utilisateurs : le désactiver plutôt)' } })

export default defineEventHandler(async (event) => {
  const actor = await requirePermission(event, 'user:manage')
  const { id } = await getValidatedRouterParams(event, idParam.parse)
  const [idp] = await db().select().from(schema.identityProviders).where(eq(schema.identityProviders.id, id))
  if (!idp) throw createError({ statusCode: 404, statusMessage: 'Fournisseur introuvable' })
  const users = await db().$count(schema.users, eq(schema.users.idpId, id))
  if (users) throw createError({ statusCode: 409, statusMessage: `${users} utilisateur(s) rattaché(s) : désactiver le fournisseur plutôt que le supprimer` })
  await db().transaction(async (tx) => {
    await tx.delete(schema.identityProviders).where(eq(schema.identityProviders.id, id))
    if (idp.clientSecretId) await tx.delete(schema.secrets).where(eq(schema.secrets.id, idp.clientSecretId))
  })
  forgetConfig(id)
  await audit({ actorUserId: actor.id, actorLabel: actor.email, action: 'idp.delete', targetType: 'identity_provider', targetId: id, outcome: 'success', ip: clientIp(event), details: { key: idp.key } })
  return { ok: true }
})
