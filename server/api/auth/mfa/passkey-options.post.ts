import { z } from 'zod'
import { passkeyAuthOptions, storeWebauthnChallenge, useChallenge } from '../../../auth/mfa'
import { enforceRateLimit } from '../../../auth/rate-limit'
import { clientIp } from '../../../utils/auth'
import { readValidated } from '../../../utils/validation'

defineRouteMeta({ openAPI: { tags: ['auth'], summary: 'Options WebAuthn pour valider la seconde étape avec une passkey du compte' } })

export default defineEventHandler(async (event) => {
  await enforceRateLimit(event, `mfa-ip:${clientIp(event) ?? 'inconnue'}`, 30, 60, 'Trop de tentatives : patienter une minute')
  const { mfaToken } = await readValidated(event, z.object({ mfaToken: z.string().max(100) }))
  const ch = await useChallenge(mfaToken)
  const options = await passkeyAuthOptions(event, ch.userId)
  await storeWebauthnChallenge(mfaToken, options.challenge)
  return options
})
