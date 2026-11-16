import { z } from 'zod'
import { disableTotp } from '../../../auth/mfa'
import { requireOwnPassword } from '../../../auth/reauth'
import { audit } from '../../../utils/audit'
import { clientIp } from '../../../utils/auth'
import { readValidated } from '../../../utils/validation'

defineRouteMeta({ openAPI: { tags: ['account'], summary: 'Désactive le TOTP (mot de passe exigé)' } })

export default defineEventHandler(async (event) => {
  const { password } = await readValidated(event, z.object({ password: z.string().max(256) }))
  const u = await requireOwnPassword(event, password)
  await disableTotp(u.id)
  await audit({ actorUserId: u.id, actorLabel: u.email, action: 'account.mfa_totp_disable', outcome: 'success', ip: clientIp(event) })
  return { ok: true }
})
