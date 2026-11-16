import { eq } from 'drizzle-orm'
import { db, schema } from '../../../db/client'
import { requirePermission } from '../../../utils/auth'
import { idParam } from '../../../utils/validation'
import { deploymentScope } from '../../../services/deployments'

defineRouteMeta({ openAPI: { tags: ['deployments'], summary: 'Release du déploiement : Compose source et final, diff, analyse' } })

export default defineEventHandler(async (event) => {
  const { id } = await getValidatedRouterParams(event, idParam.parse)
  await requirePermission(event, 'deployment:read', await deploymentScope(id))
  const [r] = await db().select({ release: schema.releases }).from(schema.deployments)
    .innerJoin(schema.releases, eq(schema.releases.id, schema.deployments.releaseId))
    .where(eq(schema.deployments.id, id))
  if (!r) return null
  const x = r.release
  return { number: x.number, slug: x.slug, composePath: x.composePath, composeSource: x.composeSource, composeFinal: x.composeFinal, composeDiff: x.composeDiff, analysis: x.analysis, images: x.images }
})
