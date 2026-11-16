import { desc, eq } from 'drizzle-orm'
import { db, schema } from '../../../db/client'
import { requirePermission } from '../../../utils/auth'
import { idParam } from '../../../utils/validation'
import { getTargetOr404, targetScope } from '../../../services/projects'
import { releaseSourceFiles } from '../../../services/release-sources'
import { patchComposeImages } from '../../../lib/compose/image-upgrade'

defineRouteMeta({ openAPI: { tags: ['targets'], summary: 'Compose source de la release active (ou de la dernière tentée), point de départ d\'un nouveau déploiement' } })

export interface CurrentComposeDto {
  release: { number: number, active: boolean, sourceKind: 'zip' | 'github', at: string } | null
  composePath: string | null
  composeText: string | null
  /** Autres fichiers de l'archive (binds, Dockerfile…) : non repris par un Compose saisi. */
  otherFiles: number
}

export default defineEventHandler(async (event): Promise<CurrentComposeDto> => {
  const { id } = await getValidatedRouterParams(event, idParam.parse)
  const t = await getTargetOr404(id)
  await requirePermission(event, 'project:read', targetScope(t))
  const [rel] = t.target.currentReleaseId
    ? await db().select().from(schema.releases).where(eq(schema.releases.id, t.target.currentReleaseId))
    : await db().select().from(schema.releases).where(eq(schema.releases.targetId, id)).orderBy(desc(schema.releases.number)).limit(1)
  if (!rel?.composeSource) return { release: null, composePath: null, composeText: null, otherFiles: 0 }
  const files = await releaseSourceFiles(rel).catch(() => new Set<string>())
  const others = [...files].filter(f => f !== rel.composePath && !f.endsWith('/'))
  return {
    release: { number: rel.number, active: rel.id === t.target.currentReleaseId, sourceKind: rel.sourceKind, at: rel.createdAt.toISOString() },
    composePath: rel.composePath,
    // Images mises à niveau encore en surcharge (source GitHub…) : montrées dans le Compose proposé.
    composeText: patchComposeImages(rel.composeSource, Object.entries(t.target.composeOverrides?.images ?? {}).map(([service, o]) => ({ service, from: o.from, to: o.image }))).composeText,
    otherFiles: others.length,
  }
})
