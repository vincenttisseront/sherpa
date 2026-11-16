import { z } from 'zod'
import { closeExec, getExec } from '../../services/exec'
import { requireUser } from '../../utils/auth'

defineRouteMeta({ openAPI: { tags: ['live'], summary: 'Ferme un terminal de conteneur' } })

export default defineEventHandler(async (event) => {
  const user = requireUser(event)
  const { sid } = await getValidatedRouterParams(event, z.object({ sid: z.string().min(10).max(40) }).parse)
  const s = user.id && !event.context.apiToken ? getExec(sid, user.id) : null
  if (s) await closeExec(sid, 'fermé par l\'utilisateur')
  return { ok: true }
})
