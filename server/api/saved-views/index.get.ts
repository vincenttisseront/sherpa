import { and, asc, eq } from 'drizzle-orm'
import { z } from 'zod'
import { TABLE_KEYS, type SavedViewDto } from '../../../shared/schemas/saved-views'
import { db, schema } from '../../db/client'
import { requireUser } from '../../utils/auth'

defineRouteMeta({ openAPI: { tags: ['tables'], summary: 'Vues sauvegardées de l\'utilisateur pour un tableau' } })

export default defineEventHandler(async (event): Promise<SavedViewDto[]> => {
  const user = requireUser(event)
  const { table } = await getValidatedQuery(event, z.object({ table: z.enum(TABLE_KEYS) }).parse)
  if (!user.id) return []
  const rows = await db().select().from(schema.savedViews).where(and(eq(schema.savedViews.userId, user.id), eq(schema.savedViews.tableKey, table))).orderBy(asc(schema.savedViews.name))
  return rows.map(r => ({ id: r.id, tableKey: r.tableKey, name: r.name, state: r.state as Record<string, unknown>, createdAt: r.createdAt.toISOString() }))
})
