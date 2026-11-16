import { z } from 'zod'
import { deletePasskey } from '../../../../auth/mfa'
import { requireOwnPassword } from '../../../../auth/reauth'
import { audit } from '../../../../utils/audit'
import { clientIp } from '../../../../utils/auth'
import { idParam, readValidated } from '../../../../utils/validation'

defineRouteMeta({ openAPI: { tags: ['account'], summary: 'Supprime une de mes passkeys (mot de passe exigé)' } })

export default defineEventHandler(async (event) => {
  const { id } = await getValidatedRouterParams(event, idParam.parse)
  const { password } = await readValidated(event, z.object({ password: z.string().max(256) }))
  const u = await requireOwnPassword(event, password)
  if (!(await deletePasskey(u.id, id))) throw createError({ statusCode: 404, statusMessage: 'Passkey introuvable' })
  await audit({ actorUserId: u.id, actorLabel: u.email, action: 'account.mfa_passkey_remove', outcome: 'success', ip: clientIp(event), details: { passkeyId: id } })
  return { ok: true }
})
