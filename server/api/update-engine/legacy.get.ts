import type { LegacyWatchtowerItem } from '../../../shared/schemas/update-engine'
import { requireAnyPermission } from '../../utils/auth'
import { scanLegacyWatchtower } from '../../services/update-engine'

defineRouteMeta({ openAPI: { tags: ['watchtower'], summary: 'Anciens conteneurs et images Watchtower sur les hôtes (autre image que celle choisie)' } })

export default defineEventHandler(async (event): Promise<LegacyWatchtowerItem[]> => {
  const user = await requireAnyPermission(event, 'server:read')
  return scanLegacyWatchtower(user)
})
