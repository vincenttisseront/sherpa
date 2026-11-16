import { z } from 'zod'
import { audit } from '../../../utils/audit'
import { clientIp, requirePermission } from '../../../utils/auth'
import { idParam, readValidated } from '../../../utils/validation'
import { importEnvFiles } from '../../../services/env-import'
import { getTargetOr404, targetScope } from '../../../services/projects'

defineRouteMeta({ openAPI: { tags: ['targets'], summary: 'Importe les env_file du Compose (archive ou commit GitHub) en variables chiffrées de la cible ; renvoie les noms seulement' } })

const input = z.discriminatedUnion('source', [
  z.object({ source: z.literal('upload'), uploadId: z.uuid(), composePath: z.string().min(1).max(512), overwrite: z.boolean().default(false), regenerateSecrets: z.boolean().default(true) }),
  z.object({ source: z.literal('github'), refType: z.enum(['branch', 'tag', 'commit']), ref: z.string().trim().min(1).max(250), overwrite: z.boolean().default(false), regenerateSecrets: z.boolean().default(true) }),
])

export default defineEventHandler(async (event) => {
  const { id } = await getValidatedRouterParams(event, idParam.parse)
  const t = await getTargetOr404(id)
  const user = await requirePermission(event, 'project:update', targetScope(t))
  const r = await importEnvFiles(t, await readValidated(event, input))
  await audit({ actorUserId: user.id, actorLabel: user.email, action: 'target.variables.import', targetType: 'project_target', targetId: id, ...targetScope(t), outcome: 'success', ip: clientIp(event), details: { files: r.files, imported: r.imported.map(i => i.name), secrets: r.imported.filter(i => i.secret).length, regenerated: r.imported.filter(i => i.regenerated).length, kept: r.kept } })
  return r
})
