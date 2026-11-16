import { and, eq } from 'drizzle-orm'
import { db, schema } from '../../db/client'
import { requireUser } from '../../utils/auth'
import { idParam } from '../../utils/validation'

defineRouteMeta({ openAPI: { tags: ['tables'], summary: 'Supprime une vue sauvegardée (de l\'utilisateur uniquement)' } })

export default defineEventHandler(async (event) => {
  const user = requireUser(event)
  const { id } = await getValidatedRouterParams(event, idParam.parse)
  const r = user.id ? await db().delete(schema.savedViews).where(and(eq(schema.savedViews.id, id), eq(schema.savedViews.userId, user.id))).returning({ id: schema.savedViews.id }) : []
  if (!r.length) throw createError({ statusCode: 404, statusMessage: 'Vue introuvable' })
  setResponseStatus(event, 204)
  return null
})
