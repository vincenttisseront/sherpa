import { scanCleanupInput } from '../../../shared/schemas/trivy'
import { audit } from '../../utils/audit'
import { clientIp, requirePermission } from '../../utils/auth'
import { readValidated } from '../../utils/validation'
import { cleanupScans } from '../../services/trivy'

defineRouteMeta({ openAPI: { tags: ['vulnerabilities'], summary: 'Nettoie les analyses : images arrêtées, analyses plus anciennes d\'une même image, échecs, code source sans release active, ou tout (aperçu par défaut)' } })

export default defineEventHandler(async (event) => {
  const user = await requirePermission(event, 'policy:manage')
  const input = await readValidated(event, scanCleanupInput)
  const r = await cleanupScans(input)
  if (!input.dryRun) await audit({ actorUserId: user.id, actorLabel: user.email, action: 'vulnerability.cleanup', targetType: 'platform', outcome: 'success', ip: clientIp(event), details: { ...input, images: r.images, sources: r.sources, unreachable: r.unreachable } })
  return r
})
