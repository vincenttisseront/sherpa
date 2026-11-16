import { z } from 'zod'
import { PROGRESS_ID_RE, type ProgressState } from '../../../shared/schemas/progress'
import { redis } from '../../queue/redis'
import { requireUser } from '../../utils/auth'
import { progressKey } from '../../utils/progress'

defineRouteMeta({ openAPI: { tags: ['system'], summary: 'Avancement d\'une opération longue en cours (de l\'utilisateur connecté)' } })

export default defineEventHandler(async (event): Promise<ProgressState | null> => {
  const user = requireUser(event)
  const { id } = await getValidatedRouterParams(event, z.object({ id: z.string().regex(PROGRESS_ID_RE) }).parse)
  setResponseHeader(event, 'cache-control', 'no-store')
  const raw = await redis().get(progressKey(user.id, id))
  return raw ? JSON.parse(raw) as ProgressState : null
})
