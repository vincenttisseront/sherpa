import { z } from 'zod'
import { audit } from '../../../../../utils/audit'
import { clientIp, requirePermission } from '../../../../../utils/auth'
import { readValidated } from '../../../../../utils/validation'
import { moveServiceFile } from '../../../../../services/service-files'
import { getTargetOr404, targetScope } from '../../../../../services/projects'

defineRouteMeta({ openAPI: { tags: ['targets'], summary: 'Déplace un fichier, un dossier ou un lien d\'un service vers un autre dossier du même montage' } })

const params = z.object({ id: z.uuid(), service: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,99}$/) })
const body = z.object({ mount: z.string().min(1).max(1024), path: z.string().max(1024).default(''), to: z.string().max(1024) })

export default defineEventHandler(async (event) => {
  const { id, service } = await getValidatedRouterParams(event, params.parse)
  const t = await getTargetOr404(id)
  const user = await requirePermission(event, 'deployment:execute', targetScope(t))
  const q = await readValidated(event, body)
  const base = { actorUserId: user.id, actorLabel: user.email, action: 'target.file_move', targetType: 'project_target', targetId: id, ...targetScope(t), ip: clientIp(event) }
  try {
    const r = await moveServiceFile(t, service, q.mount, q.path, q.to)
    await audit({ ...base, outcome: 'success', details: { service, mount: q.mount, ...r } })
    return r
  }
  catch (err) {
    await audit({ ...base, outcome: 'failure', details: { service, mount: q.mount, path: q.path, to: q.to, error: (err as { statusMessage?: string, message?: string }).statusMessage ?? (err as Error).message } })
    throw err
  }
})
