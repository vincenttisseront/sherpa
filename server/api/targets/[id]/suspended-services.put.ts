import { eq } from 'drizzle-orm'
import { z } from 'zod'
import { db, schema } from '../../../db/client'
import { audit } from '../../../utils/audit'
import { clientIp, requirePermission } from '../../../utils/auth'
import { idParam, readValidated } from '../../../utils/validation'
import { createLifecycleAction } from '../../../services/deploy-requests'
import { getTargetOr404, targetScope } from '../../../services/projects'

defineRouteMeta({ openAPI: { tags: ['targets'], summary: 'Suspend un service (retiré de la stack, ni démarré ni contrôlé) ou le reprend ; appliqué par un redéploiement sans mise à jour des images' } })

const input = z.object({
  service: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,62}$/),
  suspended: z.boolean(),
  /** Appliquer aussitôt (redéploiement de la release active) ; sinon au prochain déploiement. */
  apply: z.boolean().default(true),
})

export default defineEventHandler(async (event) => {
  const { id } = await getValidatedRouterParams(event, idParam.parse)
  const t = await getTargetOr404(id)
  const user = await requirePermission(event, 'deployment:execute', targetScope(t))
  const { service, suspended, apply } = await readValidated(event, input)
  const o = t.target.composeOverrides ?? {}
  const next = Object.fromEntries(Object.entries(o.suspendedServices ?? {}).filter(([k]) => k !== service))
  if (suspended) next[service] = { at: new Date().toISOString(), by: user.email }
  await db().update(schema.projectTargets).set({ composeOverrides: { ...o, suspendedServices: next } }).where(eq(schema.projectTargets.id, id))
  t.target.composeOverrides = { ...o, suspendedServices: next }
  // Appliqué par un redéploiement de la release active, sans récupérer les images (rien d'autre ne change).
  const deploymentId = apply && t.target.currentReleaseId && t.target.portainerStackId
    ? await createLifecycleAction(t, 'redeploy', user.id, `suspend:${id}:${service}-${suspended ? 'on' : 'off'}-${crypto.randomUUID()}`, { noPull: true })
    : null
  await audit({ actorUserId: user.id, actorLabel: user.email, action: suspended ? 'target.service_suspended' : 'target.service_resumed', targetType: 'target', targetId: id, ...targetScope(t), outcome: 'success', ip: clientIp(event), details: { service, deploymentId } })
  return { suspended: Object.keys(next), deploymentId }
})
