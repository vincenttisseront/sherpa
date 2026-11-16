import { eq } from 'drizzle-orm'
import { idpInput } from '../../../../shared/schemas/admin'
import { forgetConfig } from '../../../auth/oidc'
import { db, schema } from '../../../db/client'
import { audit } from '../../../utils/audit'
import { clientIp, requirePermission } from '../../../utils/auth'
import { encryptSecret } from '../../../utils/crypto'
import { idParam, readValidated } from '../../../utils/validation'

defineRouteMeta({ openAPI: { tags: ['admin'], summary: 'Modifie un fournisseur OIDC (secret absent = inchangé)' } })

export default defineEventHandler(async (event) => {
  const actor = await requirePermission(event, 'user:manage')
  const { id } = await getValidatedRouterParams(event, idParam.parse)
  const { clientSecret, key: _key, ...input } = await readValidated(event, idpInput)
  const [idp] = await db().select().from(schema.identityProviders).where(eq(schema.identityProviders.id, id))
  if (!idp) throw createError({ statusCode: 404, statusMessage: 'Fournisseur introuvable' })
  await db().transaction(async (tx) => {
    let clientSecretId = idp.clientSecretId
    if (clientSecret) {
      const { envelope, keyId } = encryptSecret(clientSecret)
      if (clientSecretId) await tx.update(schema.secrets).set({ envelope, keyId, rotatedAt: new Date() }).where(eq(schema.secrets.id, clientSecretId))
      else clientSecretId = (await tx.insert(schema.secrets).values({ purpose: 'oidc_client_secret', envelope, keyId }).returning({ id: schema.secrets.id }))[0]!.id
    }
    await tx.update(schema.identityProviders).set({ ...input, clientSecretId }).where(eq(schema.identityProviders.id, id))
  })
  forgetConfig(id)
  await audit({ actorUserId: actor.id, actorLabel: actor.email, action: 'idp.update', targetType: 'identity_provider', targetId: id, outcome: 'success', ip: clientIp(event), details: { ...input, secretChanged: !!clientSecret } })
  return { ok: true }
})
