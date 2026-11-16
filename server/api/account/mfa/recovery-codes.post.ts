import { z } from 'zod'
import { hasMfa, mfaStatus, regenerateRecoveryCodes } from '../../../auth/mfa'
import { requireOwnPassword } from '../../../auth/reauth'
import { audit } from '../../../utils/audit'
import { clientIp } from '../../../utils/auth'
import { readValidated } from '../../../utils/validation'

defineRouteMeta({ openAPI: { tags: ['account'], summary: 'Génère de nouveaux codes de secours (les anciens sont annulés ; mot de passe exigé)' } })

export default defineEventHandler(async (event) => {
  const { password } = await readValidated(event, z.object({ password: z.string().max(256) }))
  const u = await requireOwnPassword(event, password)
  if (!hasMfa(await mfaStatus(u.id))) throw createError({ statusCode: 409, statusMessage: 'Activer d\'abord un second facteur' })
  const codes = await regenerateRecoveryCodes(u.id)
  await audit({ actorUserId: u.id, actorLabel: u.email, action: 'account.mfa_recovery_codes', outcome: 'success', ip: clientIp(event) })
  return { recoveryCodes: codes }
})
