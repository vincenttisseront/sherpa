import { scanRequestInput } from '../../../shared/schemas/trivy'
import { audit } from '../../utils/audit'
import { clientIp, requirePermission } from '../../utils/auth'
import { readValidated } from '../../utils/validation'
import { getEndpointOr404 } from '../../services/servers'
import { getTargetOr404, targetScope } from '../../services/projects'
import { requestTrivyScan } from '../../services/trivy'
import { requireSubjectAccess } from '../../utils/remediation-access'
import { db, schema } from '../../db/client'
import { eq } from 'drizzle-orm'

defineRouteMeta({ openAPI: { tags: ['vulnerabilities'], summary: 'Lance une analyse Trivy : toutes les images, celles d\'un endpoint, d\'une cible, une seule image ou un seul code source' } })

export default defineEventHandler(async (event) => {
  const input = await readValidated(event, scanRequestInput)
  // Une seule image ou un seul code source (ligne de la page Vulnérabilités) : mêmes droits qu'une demande de correction.
  if (input.imageScanId || input.sourceScanId) {
    const subject = input.imageScanId ? { type: 'image' as const, id: input.imageScanId } : { type: 'source' as const, id: input.sourceScanId! }
    const u = await requireSubjectAccess(event, subject, true)
    const [img] = input.imageScanId ? await db().select({ endpointId: schema.imageScans.endpointId, imageId: schema.imageScans.imageId, image: schema.imageScans.image }).from(schema.imageScans).where(eq(schema.imageScans.id, input.imageScanId)) : []
    const [src] = input.sourceScanId ? await db().select({ targetId: schema.sourceScans.targetId }).from(schema.sourceScans).where(eq(schema.sourceScans.id, input.sourceScanId)) : []
    if (!img && !src) throw createError({ statusCode: 404, statusMessage: 'Analyse introuvable' })
    await requestTrivyScan(img ? { endpointId: img.endpointId, imageId: img.imageId, trigger: `manuelle (${u.email})` } : { targetId: src!.targetId, sourceOnly: true, trigger: `manuelle (${u.email})` })
    await audit({ actorUserId: u.id, actorLabel: u.email, action: 'vulnerability.scan', targetType: img ? 'image' : 'project_target', targetId: img?.image ?? src!.targetId, outcome: 'success', ip: clientIp(event), details: input })
    setResponseStatus(event, 202)
    return { queued: true }
  }
  let user
  if (input.targetId) user = await requirePermission(event, 'deployment:execute', targetScope(await getTargetOr404(input.targetId)))
  else if (input.endpointId) user = await requirePermission(event, 'server:manage', { serverId: (await getEndpointOr404(input.endpointId)).serverId })
  else user = await requirePermission(event, 'policy:manage')
  await requestTrivyScan({ ...input, trigger: `manuelle (${user.email})` })
  await audit({ actorUserId: user.id, actorLabel: user.email, action: 'vulnerability.scan', targetType: input.targetId ? 'project_target' : input.endpointId ? 'server_endpoint' : 'platform', targetId: input.targetId ?? input.endpointId, outcome: 'success', ip: clientIp(event), details: input })
  setResponseStatus(event, 202)
  return { queued: true }
})
