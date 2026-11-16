import { requirePermission } from '../../../utils/auth'
import { idParam } from '../../../utils/validation'
import { getTargetOr404, targetScope } from '../../../services/projects'
import { targetImageScans, targetSourceScan, trivyStatus } from '../../../services/trivy'

defineRouteMeta({ openAPI: { tags: ['targets'], summary: 'Vulnérabilités des images de la cible (dernière analyse Trivy)' } })

export default defineEventHandler(async (event) => {
  const { id } = await getValidatedRouterParams(event, idParam.parse)
  const t = await getTargetOr404(id)
  await requirePermission(event, 'project:read', targetScope(t))
  return { run: (await trivyStatus()).run, images: await targetImageScans(t.target.id, t.target.endpointId), source: await targetSourceScan(t.target.id) }
})
