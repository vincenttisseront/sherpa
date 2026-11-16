import { z } from 'zod'
import { audit } from '../../../../../utils/audit'
import { clientIp, requirePermission } from '../../../../../utils/auth'
import { readValidated } from '../../../../../utils/validation'
import { setServiceFilePermissions } from '../../../../../services/service-files'
import { getTargetOr404, targetScope } from '../../../../../services/projects'

defineRouteMeta({ openAPI: { tags: ['targets'], summary: 'Change les droits (mode) et le propriétaire (uid:gid) d\'un fichier ou d\'un dossier d\'un service, récursivement au choix' } })

const params = z.object({ id: z.uuid(), service: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,99}$/) })
const id32 = z.number().int().min(0).max(4_294_967_294).nullable().default(null)
const body = z.object({
  mount: z.string().min(1).max(1024),
  path: z.string().max(1024).default(''),
  mode: z.string().regex(/^[0-7]{3,4}$/, 'Mode octal attendu (ex. 644)').nullable().default(null),
  uid: id32,
  gid: id32,
  recursive: z.boolean().default(false),
})

export default defineEventHandler(async (event) => {
  const { id, service } = await getValidatedRouterParams(event, params.parse)
  const t = await getTargetOr404(id)
  const user = await requirePermission(event, 'deployment:execute', targetScope(t))
  const q = await readValidated(event, body)
  const base = { actorUserId: user.id, actorLabel: user.email, action: 'target.file_permissions', targetType: 'project_target', targetId: id, ...targetScope(t), ip: clientIp(event) }
  try {
    const r = await setServiceFilePermissions(t, service, q)
    await audit({ ...base, outcome: 'success', details: { service, mount: q.mount, path: r.path, mode: q.mode, uid: q.uid, gid: q.gid, recursive: q.recursive, result: `${r.mode} ${r.owner}` } })
    return r
  }
  catch (err) {
    await audit({ ...base, outcome: 'failure', details: { service, mount: q.mount, path: q.path, mode: q.mode, uid: q.uid, gid: q.gid, recursive: q.recursive, error: (err as { statusMessage?: string, message?: string }).statusMessage ?? (err as Error).message } })
    throw err
  }
})
