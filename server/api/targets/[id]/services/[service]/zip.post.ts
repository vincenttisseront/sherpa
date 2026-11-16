import { z } from 'zod'
import { audit } from '../../../../../utils/audit'
import { clientIp, requirePermission } from '../../../../../utils/auth'
import { readValidated } from '../../../../../utils/validation'
import { createServiceZip } from '../../../../../services/service-files'
import { getTargetOr404, targetScope } from '../../../../../services/projects'

defineRouteMeta({ openAPI: { tags: ['targets'], summary: 'Crée une archive zip d\'un fichier ou d\'un dossier d\'un service, déposée à côté de lui' } })

const params = z.object({ id: z.uuid(), service: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,99}$/) })
const body = z.object({ mount: z.string().min(1).max(1024), path: z.string().min(1).max(1024).optional(), paths: z.array(z.string().min(1).max(1024)).min(1).max(500).optional() }).refine(b => b.path || b.paths, 'Élément à archiver requis')

export default defineEventHandler(async (event) => {
  const { id, service } = await getValidatedRouterParams(event, params.parse)
  const t = await getTargetOr404(id)
  const user = await requirePermission(event, 'deployment:execute', targetScope(t))
  const q = await readValidated(event, body)
  const base = { actorUserId: user.id, actorLabel: user.email, action: 'target.file_zip', targetType: 'project_target', targetId: id, ...targetScope(t), ip: clientIp(event) }
  try {
    const r = await createServiceZip(t, service, q.mount, q.paths ?? [q.path!])
    await audit({ ...base, outcome: 'success', details: { service, mount: q.mount, source: q.paths ?? [q.path], ...r } })
    return r
  }
  catch (err) {
    await audit({ ...base, outcome: 'failure', details: { service, mount: q.mount, source: q.paths ?? [q.path], error: (err as { statusMessage?: string, message?: string }).statusMessage ?? (err as Error).message } })
    throw err
  }
})
