import { requirePermission } from '../../utils/auth'
import { idParam } from '../../utils/validation'
import { getUpload } from '../../services/uploads'

defineRouteMeta({ openAPI: { tags: ['uploads'], summary: 'Archive déposée encore disponible (non déployée) : rapport d\'inspection, pour reprendre un déploiement' } })

export default defineEventHandler(async (event) => {
  const { id } = await getValidatedRouterParams(event, idParam.parse)
  await requirePermission(event, 'source:import')
  const u = await getUpload(id)
  if (!u || u.consumedAt) throw createError({ statusCode: 404, statusMessage: 'Archive introuvable, déjà déployée ou expirée' })
  return { id: u.id, originalName: u.originalName, sizeBytes: u.sizeBytes, sha256: u.sha256, report: u.report }
})
