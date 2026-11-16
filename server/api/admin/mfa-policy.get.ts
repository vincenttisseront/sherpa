import { getMfaPolicy } from '../../auth/mfa'
import { requirePermission } from '../../utils/auth'

defineRouteMeta({ openAPI: { tags: ['admin'], summary: 'Politique de double authentification (off, admins, all)' } })

export default defineEventHandler(async (event) => {
  await requirePermission(event, 'policy:manage')
  return { required: await getMfaPolicy() }
})
