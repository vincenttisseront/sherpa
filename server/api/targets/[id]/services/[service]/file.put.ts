import { z } from 'zod'
import { serviceFileWrite } from '../../../../../../shared/schemas/service-files'
import { audit } from '../../../../../utils/audit'
import { clientIp, requirePermission } from '../../../../../utils/auth'
import { readValidated } from '../../../../../utils/validation'
import { writeServiceFile } from '../../../../../services/service-files'
import { getTargetOr404, targetScope } from '../../../../../services/projects'

defineRouteMeta({ openAPI: { tags: ['targets'], summary: 'Modifie ou crée un fichier texte d\'un service (ancienne version copiée à côté ; service arrêté puis relancé au choix)' } })

const params = z.object({ id: z.uuid(), service: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,99}$/) })

export default defineEventHandler(async (event) => {
  const { id, service } = await getValidatedRouterParams(event, params.parse)
  const t = await getTargetOr404(id)
  const user = await requirePermission(event, 'deployment:execute', targetScope(t))
  const input = await readValidated(event, serviceFileWrite)
  const base = { actorUserId: user.id, actorLabel: user.email, action: 'target.file_write', targetType: 'project_target', targetId: id, ...targetScope(t), ip: clientIp(event) }
  try {
    const r = await writeServiceFile(t, service, input)
    await audit({ ...base, outcome: 'success', details: { service, mount: input.mount, path: input.path, bytes: Buffer.byteLength(input.content), created: input.sha256 === null, backup: r.backup, restarted: r.restarted } })
    return r
  }
  catch (err) {
    await audit({ ...base, outcome: 'failure', details: { service, mount: input.mount, path: input.path, error: (err as { statusMessage?: string, message?: string }).statusMessage ?? (err as Error).message } })
    throw err
  }
})
