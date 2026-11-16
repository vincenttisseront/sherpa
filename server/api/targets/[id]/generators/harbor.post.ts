import { z } from 'zod'
import { audit } from '../../../../utils/audit'
import { clientIp, requirePermission } from '../../../../utils/auth'
import { requestProgress } from '../../../../utils/progress'
import { idParam, readValidated } from '../../../../utils/validation'
import { getTargetOr404, targetScope } from '../../../../services/projects'
import { generateHarborCompose } from '../../../../services/generators'

defineRouteMeta({ openAPI: { tags: ['targets'], summary: 'Installateur Harbor : exécute l\'étape prepare sur l\'hôte (conteneur ponctuel sans réseau) et enregistre le Compose produit comme archive à analyser' } })

const input = z.object({
  uploadId: z.uuid(),
  hostname: z.string().trim().min(3).max(253),
  adminPassword: z.string().min(8).max(128).nullable().optional(),
  withTrivy: z.boolean().default(false),
})

export default defineEventHandler(async (event) => {
  const { id } = await getValidatedRouterParams(event, idParam.parse)
  const t = await getTargetOr404(id)
  const user = await requirePermission(event, 'project:update', targetScope(t))
  await requirePermission(event, 'source:import')
  const body = await readValidated(event, input)
  const r = await generateHarborCompose(t, body, user.id, requestProgress(event))
  await audit({ actorUserId: user.id, actorLabel: user.email, action: 'generator.run', targetType: 'project_target', targetId: id, ...targetScope(t), outcome: 'success', ip: clientIp(event), details: { generator: 'harbor-prepare', version: r.version, hostname: r.hostname, withTrivy: body.withTrivy, uploadId: r.upload.id, importedVariables: r.imported } })
  setResponseStatus(event, 201)
  return r
})
