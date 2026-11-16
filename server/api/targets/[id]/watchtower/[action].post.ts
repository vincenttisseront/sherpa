import { z } from 'zod'
import { requirePermission } from '../../../../utils/auth'
import { getTargetOr404, targetScope } from '../../../../services/projects'
import { getTargetWatchtower, pauseWatchtower, resumeWatchtower } from '../../../../services/watchtower'

defineRouteMeta({ openAPI: { tags: ['watchtower'], summary: 'Met en pause ou reprend Watchtower sur la stack de la cible' } })

const params = z.object({ id: z.uuid(), action: z.enum(['pause', 'resume']) })

export default defineEventHandler(async (event) => {
  const { id, action } = await getValidatedRouterParams(event, params.parse)
  const t = await getTargetOr404(id)
  const user = await requirePermission(event, action === 'pause' ? 'deployment:stop' : 'deployment:execute', targetScope(t))
  const done = action === 'pause'
    ? await pauseWatchtower(id, user.email, 'Pause manuelle', undefined, user.id ?? undefined)
    : await resumeWatchtower(id, user.email, user.id ?? undefined)
  if (!done) throw createError({ statusCode: 409, statusMessage: 'Aucun conteneur Watchtower dans la stack : appliquer la configuration d\'abord' })
  return getTargetWatchtower(await getTargetOr404(id))
})
