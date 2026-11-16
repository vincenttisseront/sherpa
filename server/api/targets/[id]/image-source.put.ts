import { z } from 'zod'
import { audit } from '../../../utils/audit'
import { clientIp, requirePermission } from '../../../utils/auth'
import { idParam, readValidated } from '../../../utils/validation'
import { useImageSource } from '../../../services/image-sources'
import { getTargetOr404, targetScope } from '../../../services/projects'

defineRouteMeta({ openAPI: { tags: ['targets'], summary: 'Utilise une source équivalente pour l\'image d\'un service (image introuvable dans son registre)' } })

const input = z.object({
  service: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,62}$/),
  from: z.string().min(1).max(300),
  image: z.string().min(1).max(300),
})

export default defineEventHandler(async (event) => {
  const { id } = await getValidatedRouterParams(event, idParam.parse)
  const t = await getTargetOr404(id)
  const user = await requirePermission(event, 'deployment:execute', targetScope(t))
  const body = await readValidated(event, input)
  const r = await useImageSource(t, body, user)
  await audit({ actorUserId: user.id, actorLabel: user.email, action: 'target.image_source', targetType: 'target', targetId: id, ...targetScope(t), outcome: 'success', ip: clientIp(event), details: r })
  return r
})
