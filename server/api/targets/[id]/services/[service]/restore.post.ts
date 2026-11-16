import { z } from 'zod'
import { audit } from '../../../../../utils/audit'
import { clientIp, requirePermission } from '../../../../../utils/auth'
import { readValidated } from '../../../../../utils/validation'
import { restoreFileVersion } from '../../../../../services/service-files'
import { getTargetOr404, targetScope } from '../../../../../services/projects'

defineRouteMeta({ openAPI: { tags: ['targets'], summary: 'Restaure une version gardée d\'un fichier d\'un service (version actuelle gardée avant)' } })

const params = z.object({ id: z.uuid(), service: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,99}$/) })
const body = z.object({ mount: z.string().min(1).max(1024), path: z.string().min(1).max(1024), version: z.string().min(1).max(300), stopService: z.boolean().default(false) })

export default defineEventHandler(async (event) => {
  const { id, service } = await getValidatedRouterParams(event, params.parse)
  const t = await getTargetOr404(id)
  const user = await requirePermission(event, 'deployment:execute', targetScope(t))
  const q = await readValidated(event, body)
  const base = { actorUserId: user.id, actorLabel: user.email, action: 'target.file_restore', targetType: 'project_target', targetId: id, ...targetScope(t), ip: clientIp(event) }
  try {
    const r = await restoreFileVersion(t, service, q)
    await audit({ ...base, outcome: 'success', details: { service, mount: q.mount, path: q.path, version: q.version, backup: r.backup, restarted: r.restarted } })
    return r
  }
  catch (err) {
    await audit({ ...base, outcome: 'failure', details: { service, mount: q.mount, path: q.path, version: q.version, error: (err as { statusMessage?: string, message?: string }).statusMessage ?? (err as Error).message } })
    throw err
  }
})
