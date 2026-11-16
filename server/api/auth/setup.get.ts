import { setupRequired } from '../../auth/setup'

defineRouteMeta({ openAPI: { tags: ['auth'], summary: 'L\'initialisation (premier administrateur) est-elle requise ?' } })

export default defineEventHandler(async () => ({ required: await setupRequired() }))
