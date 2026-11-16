import { z } from 'zod'
import type { ServiceFilesDto } from '../../../../../../shared/schemas/service-files'
import { audit } from '../../../../../utils/audit'
import { clientIp, requirePermission } from '../../../../../utils/auth'
import { listServiceFiles } from '../../../../../services/service-files'
import { getTargetOr404, targetScope } from '../../../../../services/projects'

defineRouteMeta({ openAPI: { tags: ['targets'], summary: 'Montages d\'un service et contenu d\'un de ses dossiers' } })

const params = z.object({ id: z.uuid(), service: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,99}$/) })
const query = z.object({ mount: z.string().max(1024).optional(), path: z.string().max(1024).default('') })

export default defineEventHandler(async (event): Promise<ServiceFilesDto> => {
  const { id, service } = await getValidatedRouterParams(event, params.parse)
  const { mount, path } = await getValidatedQuery(event, query.parse)
  const t = await getTargetOr404(id)
  const user = await requirePermission(event, 'deployment:execute', targetScope(t))
  const r = await listServiceFiles(t, service, mount ?? null, path)
  await audit({ actorUserId: user.id, actorLabel: user.email, action: 'target.files_list', targetType: 'project_target', targetId: id, ...targetScope(t), outcome: 'success', ip: clientIp(event), details: { service, mount: r.mount, path: r.path } })
  return r
})
