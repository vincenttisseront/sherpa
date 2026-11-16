import { z } from 'zod'
import type { ServiceFileSearchDto } from '../../../../../../shared/schemas/service-files'
import { audit } from '../../../../../utils/audit'
import { clientIp, requirePermission } from '../../../../../utils/auth'
import { searchServiceFiles } from '../../../../../services/service-files'
import { getTargetOr404, targetScope } from '../../../../../services/projects'

defineRouteMeta({ openAPI: { tags: ['targets'], summary: 'Recherche de fichiers d\'un service sous un dossier (nom, ou texte dans le contenu)' } })

const params = z.object({ id: z.uuid(), service: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,99}$/) })
const query = z.object({ mount: z.string().min(1).max(1024), path: z.string().max(1024).default(''), q: z.string().min(2).max(200), content: z.enum(['0', '1']).default('0') })

export default defineEventHandler(async (event): Promise<ServiceFileSearchDto> => {
  const { id, service } = await getValidatedRouterParams(event, params.parse)
  const q = await getValidatedQuery(event, query.parse)
  const t = await getTargetOr404(id)
  const user = await requirePermission(event, 'deployment:execute', targetScope(t))
  const r = await searchServiceFiles(t, service, q.mount, q.path, q.q, q.content === '1')
  // Texte recherché non audité (il peut s'agir d'un secret recherché dans la configuration).
  await audit({ actorUserId: user.id, actorLabel: user.email, action: 'target.files_search', targetType: 'project_target', targetId: id, ...targetScope(t), outcome: 'success', ip: clientIp(event), details: { service, mount: q.mount, path: r.path, content: r.content, results: r.results.length } })
  return r
})
