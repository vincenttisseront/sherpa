import { z } from 'zod'
import { requireAnyPermission } from '../../utils/auth'
import { readValidated } from '../../utils/validation'
import { cleanupLegacyWatchtower } from '../../services/update-engine'

defineRouteMeta({ openAPI: { tags: ['watchtower'], summary: 'Supprime d\'anciens conteneurs ou images Watchtower (revérifiés sur les hôtes ; droits server:manage par serveur)' } })

const body = z.object({ ids: z.array(z.string().regex(/^(?:sha256:)?[a-f0-9]{12,64}$/)).min(1).max(200) })

export default defineEventHandler(async (event) => {
  const user = await requireAnyPermission(event, 'server:manage')
  const { ids } = await readValidated(event, body)
  return cleanupLegacyWatchtower(user, ids)
})
