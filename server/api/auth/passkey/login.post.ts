import { z } from 'zod'
import { passkeyAuthVerify, takeWebauthnChallenge } from '../../../auth/mfa'
import { completeLogin } from '../../../auth/mfa-login'
import { enforceRateLimit } from '../../../auth/rate-limit'
import { audit } from '../../../utils/audit'
import { clientIp } from '../../../utils/auth'
import { readValidated } from '../../../utils/validation'

defineRouteMeta({ openAPI: { tags: ['auth'], summary: 'Connexion sans mot de passe avec une passkey (vérification de l\'utilisateur exigée)' } })

export default defineEventHandler(async (event) => {
  const ip = clientIp(event) ?? 'inconnue'
  await enforceRateLimit(event, `passkey-ip:${ip}`, 30, 60, 'Trop de tentatives : patienter une minute')
  const { flowId, response } = await readValidated(event, z.object({ flowId: z.string().max(100), response: z.record(z.string(), z.unknown()) }))
  const expected = await takeWebauthnChallenge(flowId)
  const ok = expected ? await passkeyAuthVerify(event, expected, response as never, null) : null
  if (!ok) {
    await audit({ actorLabel: 'passkey', action: 'auth.login', outcome: 'failure', ip, details: { method: 'passkey', reason: expected ? 'bad_passkey' : 'no_challenge' } })
    throw createError({ statusCode: 401, statusMessage: 'Passkey refusée ou expirée' })
  }
  return completeLogin(event, ok.userId, 'passkey')
})
