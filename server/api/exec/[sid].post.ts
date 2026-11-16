import { z } from 'zod'
import { getExec, touch, writeExec } from '../../services/exec'
import { requireUser } from '../../utils/auth'
import { readValidated } from '../../utils/validation'

defineRouteMeta({ openAPI: { tags: ['live'], summary: 'Saisie (input) ou taille (resize) d\'un terminal de conteneur ; la saisie n\'est jamais journalisée' } })

const body = z.discriminatedUnion('type', [
  z.object({ type: z.literal('input'), data: z.string().min(1).max(16_384) }),
  z.object({ type: z.literal('resize'), cols: z.number().int().min(20).max(500), rows: z.number().int().min(5).max(200) }),
])

export default defineEventHandler(async (event) => {
  const user = requireUser(event)
  const { sid } = await getValidatedRouterParams(event, z.object({ sid: z.string().min(10).max(40) }).parse)
  const input = await readValidated(event, body)
  const s = user.id && !event.context.apiToken ? getExec(sid, user.id) : null
  if (!s) throw createError({ statusCode: 404, statusMessage: 'Terminal introuvable ou terminé' })
  if (s.closed) throw createError({ statusCode: 410, statusMessage: 'Terminal terminé' })
  if (input.type === 'input') writeExec(s, Buffer.from(input.data, 'utf8'))
  else {
    touch(s)
    await s.session.resize(input.cols, input.rows).catch(() => undefined)
  }
  return { ok: true }
})
