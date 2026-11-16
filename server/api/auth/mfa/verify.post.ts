import { z } from 'zod'
import { consumeRecoveryCode, dropLoginChallenge, takeWebauthnChallenge, passkeyAuthVerify, useChallenge, verifyTotpLogin } from '../../../auth/mfa'
import { completeLogin } from '../../../auth/mfa-login'
import { enforceRateLimit } from '../../../auth/rate-limit'
import { audit } from '../../../utils/audit'
import { clientIp } from '../../../utils/auth'
import { readValidated } from '../../../utils/validation'

defineRouteMeta({ openAPI: { tags: ['auth'], summary: 'Seconde étape de connexion : code TOTP, code de secours ou passkey' } })

const body = z.discriminatedUnion('method', [
  z.object({ mfaToken: z.string().max(100), method: z.literal('totp'), code: z.string().trim().max(12) }),
  z.object({ mfaToken: z.string().max(100), method: z.literal('recovery'), code: z.string().trim().max(40) }),
  z.object({ mfaToken: z.string().max(100), method: z.literal('passkey'), response: z.record(z.string(), z.unknown()) }),
])

export default defineEventHandler(async (event) => {
  const ip = clientIp(event) ?? 'inconnue'
  await enforceRateLimit(event, `mfa-ip:${ip}`, 30, 60, 'Trop de tentatives : patienter une minute')
  const input = await readValidated(event, body)
  const ch = await useChallenge(input.mfaToken)
  await enforceRateLimit(event, `mfa-user:${ch.userId}`, 15, 15 * 60, 'Trop de tentatives pour ce compte : patienter quelques minutes')
  const bad = async (reason: string) => {
    await ch.fail()
    await audit({ actorUserId: ch.userId, actorLabel: ch.userId, action: 'auth.mfa', outcome: 'failure', ip, details: { method: input.method, reason } })
    throw createError({ statusCode: 401, statusMessage: 'Code incorrect' })
  }

  let remaining: number | undefined
  if (input.method === 'totp') {
    if (!(await verifyTotpLogin(ch.userId, input.code))) return bad('bad_code')
  }
  else if (input.method === 'recovery') {
    const left = await consumeRecoveryCode(ch.userId, input.code)
    if (left === null) return bad('bad_recovery_code')
    remaining = left
  }
  else {
    const expected = await takeWebauthnChallenge(input.mfaToken)
    if (!expected) return bad('no_challenge')
    const ok = await passkeyAuthVerify(event, expected, input.response as never, ch.userId)
    if (!ok) return bad('bad_passkey')
  }
  await dropLoginChallenge(input.mfaToken)
  const done = await completeLogin(event, ch.userId, input.method, remaining !== undefined ? { recoveryCodesLeft: remaining } : {})
  return { ...done, ...(remaining !== undefined ? { recoveryCodesLeft: remaining } : {}) }
})
