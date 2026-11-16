import { randomBytes } from 'node:crypto'
import { passkeyAuthOptions, storeWebauthnChallenge } from '../../../auth/mfa'
import { enforceRateLimit } from '../../../auth/rate-limit'
import { clientIp } from '../../../utils/auth'

defineRouteMeta({ openAPI: { tags: ['auth'], summary: 'Connexion sans mot de passe : options WebAuthn (passkey découvrable)' } })

export default defineEventHandler(async (event) => {
  await enforceRateLimit(event, `passkey-ip:${clientIp(event) ?? 'inconnue'}`, 30, 60, 'Trop de tentatives : patienter une minute')
  const flowId = randomBytes(18).toString('base64url')
  const options = await passkeyAuthOptions(event, null)
  await storeWebauthnChallenge(flowId, options.challenge)
  return { flowId, options }
})
