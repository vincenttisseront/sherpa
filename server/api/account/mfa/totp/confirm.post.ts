import { z } from 'zod'
import { confirmTotp } from '../../../../auth/mfa'
import { enforceRateLimit } from '../../../../auth/rate-limit'
import { requireLocalAccount } from '../../../../auth/reauth'
import { audit } from '../../../../utils/audit'
import { clientIp } from '../../../../utils/auth'
import { readValidated } from '../../../../utils/validation'

defineRouteMeta({ openAPI: { tags: ['account'], summary: 'Active le TOTP avec un premier code ; renvoie les codes de secours (une seule fois)' } })

export default defineEventHandler(async (event) => {
  const user = requireLocalAccount(event)
  await enforceRateLimit(event, `mfa-confirm:${user.id}`, 10, 15 * 60)
  const { code } = await readValidated(event, z.object({ code: z.string().trim().max(12) }))
  const r = await confirmTotp(user.id, code)
  await audit({ actorUserId: user.id, actorLabel: user.email, action: 'account.mfa_totp_enable', outcome: 'success', ip: clientIp(event) })
  return r
})
