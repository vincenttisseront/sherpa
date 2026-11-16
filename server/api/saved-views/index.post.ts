import { savedViewInput } from '../../../shared/schemas/saved-views'
import { db, schema } from '../../db/client'
import { requireUser } from '../../utils/auth'
import { readValidated } from '../../utils/validation'

defineRouteMeta({ openAPI: { tags: ['tables'], summary: 'Enregistre (ou remplace, même nom) une vue de tableau' } })

export default defineEventHandler(async (event) => {
  const user = requireUser(event)
  if (!user.id) throw createError({ statusCode: 409, statusMessage: 'Vues sauvegardées indisponibles pour ce compte' })
  const input = await readValidated(event, savedViewInput)
  const { page: _page, ...state } = input.state
  const [v] = await db().insert(schema.savedViews).values({ userId: user.id, tableKey: input.tableKey, name: input.name, state })
    .onConflictDoUpdate({ target: [schema.savedViews.userId, schema.savedViews.tableKey, schema.savedViews.name], set: { state } }).returning()
  setResponseStatus(event, 201)
  return { id: v!.id, tableKey: v!.tableKey, name: v!.name, state: v!.state, createdAt: v!.createdAt.toISOString() }
})
