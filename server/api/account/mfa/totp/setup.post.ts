import { startTotpSetup } from '../../../../auth/mfa'
import { requireLocalAccount } from '../../../../auth/reauth'
import { enforceRateLimit } from '../../../../auth/rate-limit'

defineRouteMeta({ openAPI: { tags: ['account'], summary: 'Démarre l\'activation du TOTP : secret, adresse otpauth et QR code (SVG)' } })

export default defineEventHandler(async (event) => {
  const user = requireLocalAccount(event)
  await enforceRateLimit(event, `mfa-setup:${user.id}`, 10, 15 * 60)
  return startTotpSetup(user.id, user.email)
})
