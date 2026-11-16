import { z } from 'zod'
import { requirePermission } from '../../utils/auth'
import { cleanupScans } from '../../services/trivy'

defineRouteMeta({ openAPI: { tags: ['vulnerabilities'], summary: 'Aperçu du nettoyage des analyses : nombre d\'analyses retirées par motif, sans rien supprimer' } })

const flag = z.enum(['true', 'false']).default('false').transform(v => v === 'true')
const query = z.object({ stale: flag, duplicates: flag, failed: flag, sources: flag, all: flag })

export default defineEventHandler(async (event) => {
  await requirePermission(event, 'policy:manage')
  const input = await getValidatedQuery(event, query.parse)
  return cleanupScans({ ...input, dryRun: true })
})
