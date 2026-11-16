import { getMfaPolicy, mfaRequiredFor, mfaStatus } from '../../auth/mfa'
import type { MfaStatusDto } from '../../../shared/schemas/mfa'
import { requireUser } from '../../utils/auth'

defineRouteMeta({ openAPI: { tags: ['account'], summary: 'État de ma double authentification (TOTP, codes de secours, passkeys) et politique' } })

export default defineEventHandler(async (event): Promise<MfaStatusDto> => {
  const user = requireUser(event)
  const policy = await getMfaPolicy()
  if (!user.id || user.kind === 'sso' || user.kind === 'dev') return { supported: false, policy, required: false, totp: false, recoveryCodesLeft: 0, passkeys: [] }
  return { supported: true, policy, required: await mfaRequiredFor({ id: user.id, kind: user.kind }, policy), ...(await mfaStatus(user.id)) }
})
