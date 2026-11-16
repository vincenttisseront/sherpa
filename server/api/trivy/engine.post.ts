import { z } from 'zod'
import { audit } from '../../utils/audit'
import { clientIp, requirePermission } from '../../utils/auth'
import { readValidated } from '../../utils/validation'
import { trivyEngine, updateTrivyEngine } from '../../services/trivy'

defineRouteMeta({ openAPI: { tags: ['vulnerabilities'], summary: 'Met à jour Trivy vers une version publiée (récupérée sur chaque hôte à la prochaine analyse)' } })

export default defineEventHandler(async (event) => {
  const user = await requirePermission(event, 'policy:manage')
  const { tag } = await readValidated(event, z.object({ tag: z.string().trim().max(40) }))
  const before = (await trivyEngine()).image
  const r = await updateTrivyEngine(tag, user.id)
  await audit({ actorUserId: user.id, actorLabel: user.email, action: 'trivy.update', targetType: 'platform', outcome: 'success', ip: clientIp(event), details: { from: before, to: r.image } })
  return r
})
