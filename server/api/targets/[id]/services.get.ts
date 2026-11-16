import { eq } from 'drizzle-orm'
import { db, schema } from '../../../db/client'
import { requirePermission } from '../../../utils/auth'
import { idParam } from '../../../utils/validation'
import { getTargetOr404, targetScope } from '../../../services/projects'

defineRouteMeta({ openAPI: { tags: ['targets'], summary: 'Services de la release active' } })

export default defineEventHandler(async (event): Promise<string[]> => {
  const { id } = await getValidatedRouterParams(event, idParam.parse)
  const t = await getTargetOr404(id)
  await requirePermission(event, 'project:read', targetScope(t))
  if (!t.target.currentReleaseId) return []
  const [rel] = await db().select({ images: schema.releases.images }).from(schema.releases).where(eq(schema.releases.id, t.target.currentReleaseId))
  return Object.keys((rel?.images ?? {}) as Record<string, string>).sort()
})
