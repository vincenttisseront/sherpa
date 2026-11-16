import { idpInput } from '../../../../shared/schemas/admin'
import { db, schema } from '../../../db/client'
import { audit } from '../../../utils/audit'
import { clientIp, requirePermission } from '../../../utils/auth'
import { encryptSecret } from '../../../utils/crypto'
import { pgCode, readValidated, validationError } from '../../../utils/validation'

defineRouteMeta({ openAPI: { tags: ['admin'], summary: 'Déclare un fournisseur OIDC (Keycloak, Okta…) ; le secret client est chiffré' } })

export default defineEventHandler(async (event) => {
  const actor = await requirePermission(event, 'user:manage')
  const { clientSecret, ...input } = await readValidated(event, idpInput)
  const id = await db().transaction(async (tx) => {
    let clientSecretId: string | null = null
    if (clientSecret) {
      const { envelope, keyId } = encryptSecret(clientSecret)
      clientSecretId = (await tx.insert(schema.secrets).values({ purpose: 'oidc_client_secret', envelope, keyId }).returning({ id: schema.secrets.id }))[0]!.id
    }
    return (await tx.insert(schema.identityProviders).values({ ...input, clientSecretId }).returning({ id: schema.identityProviders.id }))[0]!.id
  }).catch((err) => {
    if (pgCode(err) === '23505') throw validationError({ key: 'Identifiant déjà utilisé' })
    throw err
  })
  await audit({ actorUserId: actor.id, actorLabel: actor.email, action: 'idp.create', targetType: 'identity_provider', targetId: id, outcome: 'success', ip: clientIp(event), details: { ...input, secret: !!clientSecret } })
  setResponseStatus(event, 201)
  return { id }
})
