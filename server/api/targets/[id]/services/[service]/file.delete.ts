import { z } from 'zod'
import { audit } from '../../../../../utils/audit'
import { clientIp, requirePermission } from '../../../../../utils/auth'
import { deleteServiceFile } from '../../../../../services/service-files'
import { getTargetOr404, targetScope } from '../../../../../services/projects'

defineRouteMeta({ openAPI: { tags: ['targets'], summary: 'Supprime un fichier ou un dossier d\'un service (dossier non vide : `recursive=1`)' } })

const params = z.object({ id: z.uuid(), service: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,99}$/) })
const query = z.object({ mount: z.string().min(1).max(1024), path: z.string().min(1).max(1024), recursive: z.enum(['0', '1']).default('0') })

export default defineEventHandler(async (event) => {
  const { id, service } = await getValidatedRouterParams(event, params.parse)
  const q = await getValidatedQuery(event, query.parse)
  const t = await getTargetOr404(id)
  const user = await requirePermission(event, 'deployment:execute', targetScope(t))
  const base = { actorUserId: user.id, actorLabel: user.email, action: 'target.file_delete', targetType: 'project_target', targetId: id, ...targetScope(t), ip: clientIp(event) }
  try {
    const r = await deleteServiceFile(t, service, q.mount, q.path, q.recursive === '1')
    await audit({ ...base, outcome: 'success', details: { service, mount: q.mount, path: r.path, recursive: q.recursive === '1' } })
    return r
  }
  catch (err) {
    await audit({ ...base, outcome: 'failure', details: { service, mount: q.mount, path: q.path, error: (err as { statusMessage?: string, message?: string }).statusMessage ?? (err as Error).message } })
    throw err
  }
})
