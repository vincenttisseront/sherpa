import { z } from 'zod'
import type { ServiceFileDto } from '../../../../../../shared/schemas/service-files'
import { audit } from '../../../../../utils/audit'
import { clientIp, requirePermission } from '../../../../../utils/auth'
import { readServiceFile } from '../../../../../services/service-files'
import { getTargetOr404, targetScope } from '../../../../../services/projects'

defineRouteMeta({ openAPI: { tags: ['targets'], summary: 'Contenu d\'un fichier texte d\'un service (1 Mo au plus)' } })

const params = z.object({ id: z.uuid(), service: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,99}$/) })
const query = z.object({ mount: z.string().min(1).max(1024), path: z.string().max(1024).default('') })

export default defineEventHandler(async (event): Promise<ServiceFileDto> => {
  const { id, service } = await getValidatedRouterParams(event, params.parse)
  const { mount, path } = await getValidatedQuery(event, query.parse)
  const t = await getTargetOr404(id)
  const user = await requirePermission(event, 'deployment:execute', targetScope(t))
  const r = await readServiceFile(t, service, mount, path)
  // Contenu jamais audité : il peut contenir des secrets de l'application.
  await audit({ actorUserId: user.id, actorLabel: user.email, action: 'target.file_read', targetType: 'project_target', targetId: id, ...targetScope(t), outcome: 'success', ip: clientIp(event), details: { service, mount, path: r.path, size: r.size } })
  return r
})
