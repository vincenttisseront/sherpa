import { z } from 'zod'
import { hasMfa, mfaStatus, passkeyRegister, passkeyRegistrationOptions, regenerateRecoveryCodes } from '../../../../auth/mfa'
import type { WebauthnOptions } from '../../../../auth/mfa'
import { requireLocalAccount, requireOwnPassword } from '../../../../auth/reauth'
import { audit } from '../../../../utils/audit'
import { clientIp } from '../../../../utils/auth'
import { readValidated } from '../../../../utils/validation'

defineRouteMeta({ openAPI: { tags: ['account'], summary: 'Enregistre une passkey en deux temps : « options » (mot de passe exigé) puis « register » (réponse WebAuthn ; codes de secours si premier facteur)' } })

const body = z.discriminatedUnion('step', [
  z.object({ step: z.literal('options'), password: z.string().max(256) }),
  z.object({ step: z.literal('register'), name: z.string().trim().min(1).max(60), response: z.record(z.string(), z.unknown()) }),
])

export default defineEventHandler(async (event): Promise<{ options: WebauthnOptions | null, recoveryCodes: string[] | null }> => {
  const input = await readValidated(event, body)
  if (input.step === 'options') {
    const u = await requireOwnPassword(event, input.password)
    return { options: await passkeyRegistrationOptions(event, { id: u.id, email: u.email, displayName: u.displayName }), recoveryCodes: null }
  }
  const user = requireLocalAccount(event)
  const first = !hasMfa(await mfaStatus(user.id))
  await passkeyRegister(event, user.id, input.name, input.response as never)
  const recoveryCodes = first ? await regenerateRecoveryCodes(user.id) : null
  await audit({ actorUserId: user.id, actorLabel: user.email, action: 'account.mfa_passkey_add', outcome: 'success', ip: clientIp(event), details: { name: input.name } })
  return { options: null, recoveryCodes }
})
